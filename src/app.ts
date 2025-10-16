// @ts-nocheck
import "dotenv/config"
import axios from "axios"
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import { httpInject } from "@builderbot-plugins/openai-assistants"
import { typing } from "./utils/presence"
import fs from 'fs'
import path from 'path'

// Configuración
const PORT = process.env.PORT ?? 3008
const BASE_DIR = process.env.NODE_ENV === 'production' ? '/app' : process.cwd()
const SESSIONS_DIR = path.join(BASE_DIR, 'bot_sessions')
const userQueues = new Map();
const userLocks = new Map();
let LAST_QR: string | null = null;

const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);

    try {
        const response = await axios.post(process.env.URL_BACKEND, {
            mensaje: ctx.body,
            numero: ctx.from
        });

        const respuesta = response.data.respuesta;
        await flowDynamic([{ body: respuesta }]);

    } catch (error) {
        console.error("❌ Error al conectarse al backend:", error.message);
        await flowDynamic([{ body: "Error al procesar tu mensaje. Intenta más tarde." }]);
    }
};

const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    
    if (userLocks.get(userId)) return;

    while (queue.length > 0) {
        userLocks.set(userId, true);
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider });
        } catch (error) {
            console.error(`Error al procesar mensaje de ${userId}:`, error);
        } finally {
            userLocks.set(userId, false);
        }
    }

    userLocks.delete(userId);
    userQueues.delete(userId);
};

const welcomeFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from;

        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }

        const queue = userQueues.get(userId);
        queue.push({ ctx, flowDynamic, state, provider });

        if (!userLocks.get(userId) && queue.length === 1) {
            await handleQueue(userId);
        }
    });

const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);

    // Asegurar carpeta de sesiones para Baileys (ruta absoluta segura en Railway)
    try {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        console.log(`📁 Sesiones en: ${SESSIONS_DIR}`)
    } catch (e) {
        console.error('❌ No se pudo crear la carpeta de sesiones:', e);
    }

    const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: true,
        readStatus: false,
        auth: {
            store: SESSIONS_DIR,
            keys: SESSIONS_DIR
        },
        printQR: true,
        browser: ["Chrome (Linux)"]
    });

    const adapterDB = new MemoryDB();

    // Manejar evento QR
    adapterProvider.on('qr', (qr) => {
        console.log('\n=====================================')
        console.log('⚡ CÓDIGO QR - ESCANEA CON WHATSAPP')
        console.log('=====================================\n')
        console.log(qr)
        console.log('\n=====================================\n')
        LAST_QR = qr;
    });

    adapterProvider.on('ready', () => {
        console.log('✅ Bot conectado a WhatsApp!')
        LAST_QR = null;
    });

    // Si falla la autenticación, limpiar sesiones y reiniciar para forzar nuevo QR
    adapterProvider.on('auth_failure', async (reason) => {
        console.error('⚠️ Error de autenticación, limpiando sesiones y reiniciando...', reason)
        try {
            fs.rmSync(SESSIONS_DIR, { recursive: true, force: true })
            fs.mkdirSync(SESSIONS_DIR, { recursive: true })
        } catch (e) {
            console.error('❌ Error limpiando sesiones:', e)
        }
        // Dejar que el orquestador (Railway) reinicie la app
        process.exit(1)
    })

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    httpInject(adapterProvider.server);

    // Endpoint para visualizar el QR en el navegador
    try {
        const app = (adapterProvider as any).server;
        if (app && typeof app.get === 'function') {
            app.get('/qr', (_req, res) => {
                // Evitar caché del navegador
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');

                if (!LAST_QR) {
                    res.status(200).send(`
                        <html>
                            <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
                                <h2>⏳ Generando código QR...</h2>
                                <p>La página se actualizará automáticamente</p>
                                <script>setTimeout(() => window.location.reload(), 4000)</script>
                            </body>
                        </html>
                    `);
                    return;
                }

                res.status(200).send(`
                    <html>
                        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
                            <h2>Escanea este código QR con WhatsApp 📱</h2>
                            <pre style="background:#111;color:#0f0;padding:16px;border-radius:8px;max-width:90vw;overflow:auto">${LAST_QR}</pre>
                            <p style="margin-top:16px">El QR cambia con el tiempo. Esta página se refrescará cada 20s.</p>
                            <script>setTimeout(() => window.location.reload(), 20000)</script>
                        </body>
                    </html>
                `);
            });
        } else {
            console.warn('⚠️ No se pudo registrar /qr: servidor HTTP no disponible');
        }
    } catch (e) {
        console.error('❌ Error registrando endpoint /qr:', e);
    }

    httpServer(+PORT);
};

// Configurar manejo de errores globales
process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Promesa rechazada no manejada:', error);
});

// Iniciar el bot
(async () => {
    try {
        await main();
        console.log("🤖 Bot iniciado correctamente...");
    } catch (error) {
        console.error("❌ Error al iniciar el bot:", error);
        process.exit(1);
    }
})();

// Mantener el proceso vivo
process.stdin.resume();