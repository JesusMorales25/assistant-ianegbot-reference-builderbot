import "dotenv/config";
import axios from "axios";
import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import fs from "fs";
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

// ✅ Controladores internos
const userQueues = new Map();
const userLocks = new Map();
let currentQR = null;
let isConnected = false;
let qrRetries = 0;
const MAX_QR_RETRIES = 5;
let connectionCheckInterval: NodeJS.Timeout | null = null;

// 🧠 Procesamiento del mensaje
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

// 🧱 Manejo de colas
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

// 🧹 Función para limpiar sesión
const cleanSession = async () => {
    try {
        await fs.promises.rm('./bot_sessions', { recursive: true, force: true });
        console.log("🗑️ Archivos de sesión eliminados");
    } catch (error) {
        console.error("❌ Error al limpiar sesión:", error);
    }
};

// 🚀 Inicialización del bot
const main = async () => {
    // Limpiar sesión al inicio si hay problemas
    if (process.env.CLEAN_SESSION === "true") {
        await cleanSession();
    }
    const adapterFlow = createFlow([welcomeFlow]);
    const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: true,
        readStatus: false,
        usePairingCode: false, // Deshabilitamos código de emparejamiento para usar QR
        browser: ["IAforB2B Assistant", "Chrome", "4.0.0"], // Identificación del navegador
        auth: {
            folder: './bot_sessions', // Carpeta para guardar las sesiones
            sessionName: 'bot_session' // Nombre base para los archivos de sesión
        },
    });
    const adapterDB = new MemoryDB();

    // ⚡ Captura QR y conexión
    adapterProvider.on("qr", async (qr) => {
        console.log(`⚡ Nuevo código QR generado (intento ${qrRetries + 1}/${MAX_QR_RETRIES})`);
        try {
            currentQR = await qrcode.toDataURL(qr);
            console.log("✅ QR generado exitosamente");
            isConnected = false;
            qrRetries++;

            if (qrRetries >= MAX_QR_RETRIES) {
                console.log("🔄 Máximo de intentos de QR alcanzado, reiniciando...");
                process.exit(1); // Railway reiniciará el contenedor
            }
        } catch (error) {
            console.error("❌ Error al generar QR:", error);
            console.error(error);
            currentQR = null;
        }
    });
    
    // Manejadores adicionales de eventos
    adapterProvider.on("auth_failure", async (error) => {
        console.error("❌ Error de autenticación:", error);
        // Eliminar archivos de sesión si hay error de auth
        try {
            await fs.promises.rm('./bot_sessions', { recursive: true, force: true });
            console.log("🗑️ Archivos de sesión eliminados");
            process.exit(1); // Reiniciar para generar nueva sesión
        } catch (e) {
            console.error("❌ Error al limpiar sesión:", e);
        }
    });

    adapterProvider.on("disconnected", (reason) => {
        console.log("❌ Bot desconectado:", reason);
        isConnected = false;
        process.exit(1); // Reiniciar para reconectar
    });

    adapterProvider.on("ready", () => {
        console.log("✅ Bot conectado a WhatsApp correctamente");
        isConnected = true;
        qrRetries = 0; // Reinicia el contador cuando se conecta exitosamente
        
        // Inicia el verificador de conexión
        if (connectionCheckInterval) {
            clearInterval(connectionCheckInterval);
        }
        connectionCheckInterval = setInterval(() => {
            if (!isConnected) {
                console.log("🔄 Conexión perdida, reiniciando...");
                process.exit(1); // Railway reiniciará el contenedor
            }
        }, 30000); // Verifica cada 30 segundos
    });

    // 🚀 Configura Express
    const app = express();
    
    // Middlewares
    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // 🧩 Crear bot
    const bot = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // Rutas
    app.get("/", (req, res) => {
        res.send(`
            <html>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center">
                    <h2>🤖 Bot activo en Render / Railway</h2>
                    <p>Visita <a href="/qr">/qr</a> para escanear el código QR.</p>
                </body>
            </html>
        `);
    });

    app.get("/qr", (req, res) => {
        if (isConnected) {
            res.send(`
                <html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
                    <h2>✅ Bot conectado a WhatsApp</h2>
                    <p>Puedes cerrar esta ventana.</p>
                </body></html>
            `);
        } else if (currentQR) {
            res.send(`
                <html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
                    <h2>Escanea este código con tu WhatsApp 📱</h2>
                    <img src="${currentQR}" style="width:300px;height:300px;border:1px solid #ccc;border-radius:10px"/>
                    <p style="margin-top:20px;">Intento ${qrRetries}/${MAX_QR_RETRIES}. Si el QR no funciona, se generará uno nuevo.</p>
                    <script>
                        setTimeout(() => {
                            window.location.reload();
                        }, 30000); // Recargar cada 30 segundos si no está conectado
                    </script>
                </body></html>
            `);
        } else {
            res.send(`
                <html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
                    <h3>Generando nuevo QR...</h3>
                    <p>La página se recargará automáticamente.</p>
                    <script>
                        setTimeout(() => {
                            window.location.reload();
                        }, 5000); // Recargar cada 5 segundos si no hay QR
                    </script>
                </body></html>
            `);
        }
    });

    // 🛜 Levanta el servidor Express
    app.listen(PORT, HOST, () => {
        console.log(`🛜 Bot escuchando en http://${HOST}:${PORT}`);
        console.log(`🌐 QR disponible en http://${HOST}:${PORT}/qr`);
    });
};

main()
    .then(() => console.log("🤖 Bot iniciado correctamente..."))
    .catch((err) => console.error("❌ Error al iniciar el bot:", err));

// Manejo de señales para cierre limpio
const handleShutdown = async () => {
    console.log('\n🔄 Cerrando el bot...');
    try {
        // Aquí puedes agregar lógica de limpieza si es necesario
        process.exit(0);
    } catch (error) {
        console.error('❌ Error durante el cierre:', error);
        process.exit(1);
    }
};

process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesa rechazada no manejada:', reason);
});
