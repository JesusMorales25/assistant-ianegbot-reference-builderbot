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
const TMP_DIR = path.join(BASE_DIR, 'tmp');
const QR_PATH = path.join(BASE_DIR, 'bot.qr.png');

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

const ensureDirectories = async () => {
    try {
        // Limpiar directorios si existen
        try {
            await fs.rm(SESSIONS_DIR, { recursive: true, force: true });
            await fs.rm(TMP_DIR, { recursive: true, force: true });
            console.log("🗑️ Directorios anteriores eliminados");
        } catch (error) {
            // Ignorar errores si los directorios no existen
        }

        // Crear directorios nuevos
        await fs.mkdir(SESSIONS_DIR, { recursive: true });
        await fs.mkdir(TMP_DIR, { recursive: true });
        
        // Crear archivo de credenciales vacío
        await fs.writeFile(
            path.join(SESSIONS_DIR, 'creds.json'),
            JSON.stringify({ noiseKey: null, signedIdentityKey: null, signedPreKey: null, registrationId: null, advSecretKey: null, nextPreKeyId: null, firstUnuploadedPreKeyId: null, serverHasPreKeys: null, account: null, me: null, signalIdentities: null, lastAccountSyncTimestamp: null, myAppStateKeyId: null }),
            'utf-8'
        );
        
        console.log("📁 Directorios y archivos creados correctamente");
    } catch (error) {
        console.error("❌ Error al crear directorios:", error);
        throw error; // Propagar el error para manejo superior
    }
};

const main = async () => {
    try {
        // Asegurar que los directorios existan
        await ensureDirectories();
        
        const adapterFlow = createFlow([welcomeFlow]);
        
        const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: true,
        readStatus: false,
        auth: {
            store: SESSIONS_DIR,
            keys: SESSIONS_DIR,
            creds: path.join(SESSIONS_DIR, 'creds.json')
        },
        browser: ["Chrome (Linux)"],
        qr: {
            store: QR_PATH
        },
        linkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        retryRequestDelayMs: 10000,
        connectTimeoutMs: 60000,
        emitOwnEvents: true,
        fireInitQueries: false
    });

        const adapterDB = new MemoryDB();

        // Manejar eventos del proveedor
        adapterProvider.on('qr', async (qr) => {
            console.log('⚡ Nuevo QR generado');
            console.log('🔍 QR guardado en:', QR_PATH);
        });

        adapterProvider.on('loading_screen', (percent, message) => {
            console.log('🔄 Cargando:', percent, '%', message);
        });

        adapterProvider.on('auth_failure', async (reason) => {
            console.error('⚠️ Error de autenticación:', reason);
            // Intentar limpiar y reiniciar
            await ensureDirectories();
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