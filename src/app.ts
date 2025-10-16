import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot';
import { MemoryDB } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence.js";

/** Variables de entorno */
const PORT = process.env.PORT ? Number(process.env.PORT) : 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? '';

/** Controladores internos */
const userQueues = new Map();
const userLocks = new Map();

/**
 * Procesa el mensaje del usuario enviándolo a OpenAI
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);
    try {
        const response = await toAsk(ASSISTANT_ID, ctx.body, state);
        // Dividir la respuesta en chunks y enviarlos secuencialmente
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
 * Maneja la cola de mensajes para cada usuario
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
 * Flujo principal del bot
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

/**
 * Función principal que configura e inicia el bot
 */
const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);
    const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: true,
        readStatus: false,
        auth: {
            store: './bot_sessions',
            keys: './bot_sessions'
        },
        markOnlineOnConnect: true,
        browser: ["IAforB2B Assistant", "Chrome", "4.0.0"],
        syncFullHistory: false
    });

    const adapterDB = new MemoryDB();

    // Manejadores de eventos
    adapterProvider.on("qr", (qr) => {
        console.log("⚡ Nuevo código QR generado");
    });

    adapterProvider.on("ready", () => {
        console.log("✅ Bot conectado correctamente");
    });

    adapterProvider.on("auth_failure", (error) => {
        console.error("❌ Error de autenticación:", error);
        process.exit(1);
    });

    adapterProvider.on("disconnected", (reason) => {
        console.log("❌ Bot desconectado:", reason);
        process.exit(1);
    });

    // Crear y configurar el bot
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // Inyectar el servidor HTTP y arrancar
    httpInject(adapterProvider.server);
    httpServer(PORT);

    console.log(`🚀 Bot iniciado en el puerto ${PORT}`);
};

main()
    .then(() => console.log("✅ Bot iniciado correctamente"))
    .catch(error => {
        console.error("❌ Error al iniciar el bot:", error);
        process.exit(1);
    });

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Promesa rechazada no manejada:', reason);
    process.exit(1);
});