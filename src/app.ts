import "dotenv/config"
import axios from "axios"
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import { httpInject } from "@builderbot-plugins/openai-assistants"
import { typing } from "./utils/presence"
import path from 'path'
import fs from 'fs/promises'

// Configuración de rutas
const BASE_DIR = process.env.NODE_ENV === 'production' ? '/app' : process.cwd();
const SESSIONS_DIR = path.join(BASE_DIR, 'bot_sessions');

const PORT = process.env.PORT ?? 3008
const userQueues = new Map();
const userLocks = new Map();

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

const welcomeFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME)
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

const initializeState = async () => {
    try {
        console.log("🔄 Inicializando estado del bot...");
        
        // Crear directorios necesarios
        await fs.mkdir(SESSIONS_DIR, { recursive: true });

        // Estado inicial del bot
        const initialState = {
            creds: {
                me: { id: '', name: 'IAforB2B' },
                registered: false,
                platform: 'android'
            },
            keys: {}
        };

        // Guardar estado inicial
        const statePath = path.join(SESSIONS_DIR, 'bot.state.json');
        await fs.writeFile(statePath, JSON.stringify(initialState, null, 2));
        
        console.log("✅ Estado inicial creado correctamente");
    } catch (error) {
        console.error("❌ Error al inicializar estado:", error);
        throw error;
    }
};

const main = async () => {
    try {
        // Inicializar estado del bot
        await initializeState();
        
        const adapterFlow = createFlow([welcomeFlow]);
        
        const adapterProvider = createProvider(BaileysProvider, {
            name: 'IAforB2B-Bot', // Nombre para identificar el bot
            browserDescription: ['Chrome', 'Desktop', '1.0.0'],
            phoneNumber: '0000000000',
            useChrome: false,
            headless: true,
            auth: 'state',
            throwErrorOnTosBlock: true,
            printQR: true,
            authTimeoutMs: 60000,
            browser: ['IAforB2B', 'Chrome', '1.0.0'],
            hostNotificationLang: 'ES_es',
            logLevel: 'silent'
        });

        const adapterDB = new MemoryDB();

        // Manejar eventos del proveedor
        let qrAttempts = 0;
        const maxQrAttempts = 3;

        adapterProvider.on('qr', async (qr) => {
            qrAttempts++;
            console.log(`\n📱 Intento de QR ${qrAttempts}/${maxQrAttempts}`);
            console.log('=====================================');
            console.log('⚡ ESCANEA ESTE CÓDIGO QR EN WHATSAPP');
            console.log('=====================================\n');
            console.log(qr);
            console.log('\n=====================================');
            
            if (qrAttempts >= maxQrAttempts) {
                console.log('❌ Máximo de intentos de QR alcanzado');
                // Reiniciar estado y proceso
                await initializeState();
                process.exit(1);
            }
        });

        adapterProvider.on('loading_screen', (percent, message) => {
            console.log('🔄 Cargando:', percent, '%', message);
        });

        adapterProvider.on('auth_failure', async (reason) => {
            console.error('⚠️ Error de autenticación:', reason);
            // Intentar reinicializar estado
            await initializeState();
        });

        adapterProvider.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            console.log('🔌 Estado de conexión:', connection);
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== 403;
                console.log(shouldReconnect ? '🔄 Intentando reconexión...' : '❌ Conexión cerrada permanentemente');
            }
        });

        adapterProvider.on('ready', () => {
            console.log('✅ Bot conectado correctamente');
        });

        const { httpServer } = await createBot({
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        });

        httpInject(adapterProvider.server);
        httpServer(+PORT);
    } catch (error) {
        console.error('❌ Error en main:', error);
        throw error;
    }
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