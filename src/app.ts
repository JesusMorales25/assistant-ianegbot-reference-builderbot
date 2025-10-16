import "dotenv/config";
import axios from "axios";
import express from "express";
import qrcode from "qrcode";
import {
    createBot,
    createProvider,
    createFlow,
    addKeyword,
    EVENTS
} from "@builderbot/bot";
import { MemoryDB } from "@builderbot/bot";
import { BaileysProvider } from "@builderbot/provider-baileys";
import { httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence.js";

// ✅ Variables de entorno
const PORT = process.env.PORT ? Number(process.env.PORT) : 3008;
const HOST = process.env.HOST || "0.0.0.0";
const URL_BACKEND = process.env.URL_BACKEND;

// ✅ Manejadores de mensajes
const userQueues = new Map();
const userLocks = new Map();
let currentQR = null;

// 🧠 Procesamiento del mensaje del usuario
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);
    try {
        const response = await axios.post(URL_BACKEND, {
            mensaje: ctx.body,
            numero: ctx.from,
        });

        const respuesta = response.data.respuesta || "Sin respuesta del servidor.";
        await flowDynamic([{ body: respuesta }]);
    } catch (error) {
        console.error("❌ Error al conectarse al backend:", error.message);
        await flowDynamic([{ body: "Error al procesar tu mensaje. Intenta más tarde." }]);
    }
};

// 🧱 Control de colas
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

// 🏁 Flujo principal
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

// 🚀 Inicialización del bot
const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);
    const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: true,
        readStatus: false,
    });
    const adapterDB = new MemoryDB();

    // ⚡ Captura el QR emitido por Baileys
    adapterProvider.on("qr", async (qr) => {
        console.log("⚡ Nuevo código QR generado");
        currentQR = await qrcode.toDataURL(qr);
    });

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    httpInject(adapterProvider.server);
    httpServer(PORT);

    console.log(`🛜 HTTP Server ON http://${HOST}:${PORT}`);

    // 🌐 Servidor express
    const app = express();

    app.get("/", (req, res) => {
        res.send(`
            <html>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center">
                    <h2>🤖 Bot activo en Render</h2>
                    <p>Visita <a href="/qr">/qr</a> para escanear el código QR.</p>
                </body>
            </html>
        `);
    });

    app.get("/qr", (req, res) => {
        if (currentQR) {
            res.send(`
                <html>
                    <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
                        <h2>Escanea este código con tu WhatsApp 📱</h2>
                        <img src="${currentQR}" style="width:300px;height:300px;border:1px solid #ccc;border-radius:10px"/>
                        <p style="margin-top:20px;">Si el QR no aparece, espera unos segundos y recarga la página.</p>
                    </body>
                </html>
            `);
        } else {
            res.send("<h3>No hay QR disponible (quizá ya está conectado o no se generó aún).</h3>");
        }
    });

    app.listen(PORT, HOST, () => {
        console.log(`🌐 Vista del QR disponible en http://${HOST}:${PORT}/qr`);
    });
};

main()
    .then(() => console.log("🤖 Bot iniciado correctamente..."))
    .catch((err) => console.error("❌ Error al iniciar el bot:", err));

process.stdin.resume();
