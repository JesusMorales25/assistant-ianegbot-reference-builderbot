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
        // Crear directorios necesarios
        await fs.mkdir(SESSIONS_DIR, { recursive: true });
        await fs.mkdir(TMP_DIR, { recursive: true });
        console.log("📁 Directorios creados correctamente");
    } catch (error) {
        console.error("❌ Error al crear directorios:", error);
    }
};

const main = async () => {
    // Asegurar que los directorios existan
    await ensureDirectories();
    
    const adapterFlow = createFlow([welcomeFlow]);

    const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: true,
        readStatus: false,
        auth: {
            store: SESSIONS_DIR,
            keys: SESSIONS_DIR
        },
        browser: ["Chrome (Linux)"],
        qr: {
            store: QR_PATH
        }
    });

    const adapterDB = new MemoryDB();

    // Manejar evento QR
    adapterProvider.on('qr', async (qr) => {
        console.log('⚡ Nuevo QR generado');
        console.log('🔍 QR guardado en:', QR_PATH);
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
};

main()
    .then(() => console.log("🤖 Bot iniciado correctamente..."))
    .catch(err => console.error("❌ Error al iniciar el bot:", err));
process.stdin.resume();