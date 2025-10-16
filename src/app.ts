import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot';
import { MemoryDB } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import { toAsk } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence.js";
import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import fs from 'fs';

/** Variables de entorno */
const PORT = process.env.PORT ? Number(process.env.PORT) : 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? '';

/** Controladores internos */
const userQueues = new Map();
const userLocks = new Map();
let qrCodeValue: string | null = null;
let currentQRBase64: string | null = null;

/**
 * Procesa el mensaje del usuario
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);
    try {
        const response = await toAsk(ASSISTANT_ID, ctx.body, state);
        const chunks = response.split(/\n\n+/);
        for (const chunk of chunks) {
            const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");
            await flowDynamic([{ body: cleanedChunk }]);
        }
    } catch (error) {
        console.error("❌ Error al procesar mensaje:", error.message);
        await flowDynamic([{ body: "Lo siento, hubo un error al procesar tu mensaje. Por favor, intenta de nuevo." }]);
    }
};

/**
 * Maneja la cola de mensajes
 */
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

/**
 * Flujo principal
 */
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

// Función para limpiar sesiones anteriores
const cleanSessions = async () => {
    try {
        if (fs.existsSync('./bot_sessions')) {
            await fs.promises.rm('./bot_sessions', { recursive: true, force: true });
            console.log("🗑️ Sesiones anteriores eliminadas");
        }
        fs.mkdirSync('./bot_sessions', { recursive: true });
        console.log("📁 Carpeta de sesiones creada");
    } catch (error) {
        console.error("❌ Error al limpiar sesiones:", error);
    }
};

/**
 * Función principal
 */
const main = async () => {
    // Limpiar sesiones anteriores para forzar nuevo QR
    await cleanSessions();

    const adapterFlow = createFlow([welcomeFlow]);
    const adapterProvider = createProvider(BaileysProvider, {
        browser: ["IAforB2B Assistant", "Chrome", "4.0.0"],
        auth: {
            store: './bot_sessions',
            keys: './bot_sessions'
        },
        reconnect: false, // Desactivar reconexión automática
        qrMaxRetries: 1, // Solo permitir un intento de QR
    });

    const adapterDB = new MemoryDB();

    // Eventos del bot
    adapterProvider.on("qr", async (qr) => {
        console.log("⚡ Nuevo QR generado");
        qrCodeValue = qr;
        
        try {
            // Generar QR en base64
            currentQRBase64 = await qrcode.toDataURL(qr);
            
            // Imprimir en consola para los logs
            console.log("\n🔍 Escanea este QR con WhatsApp:");
            console.log(qr);
        } catch (error) {
            console.error("❌ Error al generar QR:", error);
        }
    });

    adapterProvider.on("ready", () => {
        console.log("✅ Bot conectado correctamente");
        qrCodeValue = null;
        currentQRBase64 = null;
        // Guardar estado de conexión
        fs.writeFileSync('./bot_sessions/connected.json', JSON.stringify({ timestamp: Date.now() }));
    });

    // Verificar si la última conexión fue hace más de 24 horas
    const checkLastConnection = () => {
        try {
            if (fs.existsSync('./bot_sessions/connected.json')) {
                const data = JSON.parse(fs.readFileSync('./bot_sessions/connected.json', 'utf8'));
                const lastConnection = new Date(data.timestamp);
                const now = new Date();
                const hours = (now.getTime() - lastConnection.getTime()) / (1000 * 60 * 60);
                
                if (hours > 24) {
                    console.log("🔄 Última conexión hace más de 24 horas, forzando reconexión");
                    return true;
                }
            }
            return false;
        } catch (error) {
            console.error("❌ Error al verificar última conexión:", error);
            return true;
        }
    };

    if (checkLastConnection()) {
        await cleanSessions();
    }

    // Crear bot
    const bot = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB
    });

    // Servidor web simple
    const app = express();
    app.use(cors());

    // Ruta para el QR
    // Ruta principal
    app.get('/', (_req, res) => {
        res.send(`
            <html>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
                    <h2>🤖 Bot de WhatsApp</h2>
                    <p>Visita <a href="/qr">/qr</a> para escanear el código QR</p>
                </body>
            </html>
        `);
    });

    // Ruta para el QR
    app.get('/qr', (_req, res) => {
        if (!currentQRBase64) {
            res.send(`
                <html>
                    <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
                        <h2>✅ Bot conectado a WhatsApp</h2>
                        <p>No hay QR disponible porque el bot ya está conectado.</p>
                        <script>
                            if (!document.querySelector('h2').textContent.includes('✅')) {
                                setTimeout(() => window.location.reload(), 5000);
                            }
                        </script>
                    </body>
                </html>
            `);
            return;
        }

        res.send(`
            <html>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
                    <h2>Escanea este código QR con WhatsApp 📱</h2>
                    <img src="${currentQRBase64}" alt="QR Code" style="width:300px;height:300px"/>
                    <p style="margin-top:20px">La página se actualizará automáticamente</p>
                    <script>
                        setTimeout(() => window.location.reload(), 20000);
                    </script>
                </body>
            </html>
        `);
    });

    // Iniciar servidor
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Servidor iniciado en el puerto ${PORT}`);
        console.log(`🌐 QR disponible en: http://localhost:${PORT}/qr`);
    });
};

main().catch(console.error);

// Manejo de errores
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);