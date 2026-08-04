const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// Conexión a Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
);

// Rutas para tus páginas
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/cocina", (req, res) => {
  res.sendFile(path.join(__dirname, "cocina.html"));
});

app.get("/domiciliario", (req, res) => {
  res.sendFile(path.join(__dirname, "domiciliario.html"));
});

// Endpoint para crear pedido con columnas reales
app.post("/pedido", async (req, res) => {
  const { nombre, direccion, telefono, barrio, observacion, platos } = req.body;

  // 1. Obtener costo de domicilio desde Supabase
  const { data: barrioData } = await supabase
    .from("barrios")
    .select("precio_domicilio")
    .eq("nombre_barrio", barrio)
    .single();

  const domicilio = barrioData?.precio_domicilio || 0;

  // 2. Calcular subtotal y total en servidor
  const subtotal = platos.reduce((acc, p) => acc + p.precio, 0);
  const total = subtotal + domicilio;

  // 3. Insertar pedido
  const { data: pedido, error } = await supabase
    .from("pedidos")
    .insert([
      {
        nombre,
        direccion,
        telefono,
        domicilio,
        subtotal,
        total,
        estado: "pendiente",
        barrio,
        observacion,
      },
    ])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // 4. Insertar detalle de platos
  await Promise.all(
    platos.map((plato) =>
      supabase.from("pedido_detalle").insert([
        {
          pedido_id: pedido.id,
          plato_id: plato.plato_id,
          nombre_plato: plato.nombre_plato,
          precio: plato.precio,
          cantidad: plato.cantidad,
        },
      ]),
    ),
  );

  // 5. Enviar confirmación al cliente por WhatsApp
  await enviarWhatsApp(
    telefono,
    `Hola ${nombre}, tu pedido fue recibido.\nTotal: $${total}\nEstado: pendiente.`,
  );

  res.json({ mensaje: "Pedido creado y notificado", pedido });
});

// Ajustar función enviarWhatsApp para recibir el número del cliente
async function enviarWhatsApp(numero, texto) {
  await fetch(
    `https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: numero,
        type: "text",
        text: { body: texto },
      }),
    },
  );
}

async function crearPedidoDesdeConversacion(conv) {
  const { nombre, direccion, telefono, barrio, platos, observacion } = conv;

  // 1. Obtener costo de domicilio desde Supabase
  const { data: barrioData, error: barrioError } = await supabase
    .from("barrios")
    .select("precio_domicilio")
    .eq("nombre_barrio", barrio)
    .single();

  if (barrioError) {
    console.error("Error obteniendo barrio:", barrioError.message);
    return;
  }

  const domicilio = barrioData?.precio_domicilio || 0;

  // 2. Calcular subtotal y total en servidor
  const subtotal = (platos || []).reduce((acc, p) => acc + (p.precio || 0), 0);
  const total = subtotal + domicilio;

  // 3. Insertar pedido en tabla pedidos
  const { data: pedido, error: pedidoError } = await supabase
    .from("pedidos")
    .insert([
      {
        nombre,
        direccion,
        telefono,
        domicilio,
        subtotal,
        total,
        estado: "pendiente",
        barrio,
        observacion,
      },
    ])
    .select()
    .single();

  if (pedidoError) {
    console.error("Error creando pedido:", pedidoError.message);
    return;
  }

  // 4. Insertar detalle de platos
  await Promise.all(
    (platos || []).map((plato) =>
      supabase.from("pedido_detalle").insert([
        {
          pedido_id: pedido.id,
          nombre_plato: plato.nombre_plato || plato,
          precio: plato.precio || 0,
          cantidad: plato.cantidad || 1,
        },
      ]),
    ),
  );

  // 5. Enviar confirmación al cliente por WhatsApp
  await enviarWhatsApp(
    telefono,
    `Hola ${nombre}, tu pedido fue recibido.\nTotal: $${total}\nEstado: pendiente.`,
  );
}

// Webhook de verificación
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "pedidos123"; // igual en Meta Developers

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verificado correctamente");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// Funciones auxiliares para extraer texto y número del JSON de Meta
// Funciones auxiliares
function obtenerTexto(body) {
  return (
    body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body || null
  );
}

function obtenerNumero(body) {
  const num = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
  return num ? num.replace("+", "") : null;
}

// Webhook
app.post("/webhook", async (req, res) => {
  const mensaje = obtenerTexto(req.body);
  const telefono = obtenerNumero(req.body);

  // Validar que haya número y texto
  if (!telefono || !mensaje) {
    console.log("ℹ️ Evento ignorado: sin número o sin texto");
    return res.sendStatus(200);
  }

  console.log("➡️ Mensaje entrante:", mensaje);
  console.log("➡️ Número entrante:", telefono);

  // Buscar conversación activa
  let { data: conv, error } = await supabase
    .from("conversaciones")
    .select("*")
    .eq("telefono", telefono)
    .maybeSingle();

  if (error) console.error("❌ Error buscando conversación:", error.message);
  console.log("📂 Conversación encontrada:", conv);

  if (!conv) {
    // Crear nueva conversación
    let { data: nuevaConv, error: insertError } = await supabase
      .from("conversaciones")
      .insert([{ telefono, estado: "nombre" }])
      .select()
      .single();

    if (insertError) {
      console.error("❌ Error insertando conversación:", insertError.message);
    } else {
      console.log("✅ Nueva conversación creada:", nuevaConv);
      await enviarWhatsApp(telefono, "Hola 👋, ¿cuál es tu nombre?");
    }
    return res.sendStatus(200);
  } else if (conv.estado === "finalizado") {
    // Reiniciar conversación existente
    await supabase
      .from("conversaciones")
      .update({
        estado: "nombre",
        nombre: null,
        direccion: null,
        barrio: null,
        platos: null,
        observacion: null,
        created_at: new Date().toISOString(),
      })
      .eq("id", conv.id);

    console.log("🔄 Conversación reiniciada:", conv.telefono);
    await enviarWhatsApp(telefono, "Hola 👋, ¿cuál es tu nombre?");
    return res.sendStatus(200);
  }

  // Flujo conversacional
  switch (conv.estado) {
    case "nombre":
      await supabase
        .from("conversaciones")
        .update({ nombre: mensaje, estado: "direccion" })
        .eq("id", conv.id);
      console.log("📌 Estado cambiado a: direccion");
      await enviarWhatsApp(telefono, "Perfecto, ahora dime tu dirección 🏠");
      break;

    case "direccion":
      await supabase
        .from("conversaciones")
        .update({ direccion: mensaje, estado: "barrio" })
        .eq("id", conv.id);
      console.log("📌 Estado cambiado a: barrio");
      await enviarWhatsApp(
        telefono,
        "¿En qué barrio estás? (ej. La Castellana)",
      );
      break;

    case "barrio":
      await supabase
        .from("conversaciones")
        .update({ barrio: mensaje, estado: "platos" })
        .eq("id", conv.id);
      console.log("📌 Estado cambiado a: platos");
      await enviarWhatsApp(
        telefono,
        "¿Qué plato deseas? 🍔🍕 (puedes escribir varios separados por coma)",
      );
      break;

    case "platos":
      await supabase
        .from("conversaciones")
        .update({
          platos: mensaje.split(",").map((p) => p.trim()),
          estado: "confirmacion",
        })
        .eq("id", conv.id);
      console.log("📌 Estado cambiado a: confirmacion");
      await enviarWhatsApp(telefono, "¿Quieres añadir alguna observación? ✍️");
      break;

    case "confirmacion":
      try {
        // Actualizar conversación a finalizado
        await supabase
          .from("conversaciones")
          .update({ observacion: mensaje, estado: "finalizado" })
          .eq("id", conv.id);

        console.log("📌 Estado cambiado a: finalizado");

        // 1. Obtener todos los barrios y buscar coincidencia aproximada
        const { data: barriosData = [], error: barriosError } = await supabase
          .from("barrios")
          .select("nombre_barrio, precio_domicilio");

        if (barriosError)
          console.warn("⚠️ Error al obtener barrios:", barriosError.message);

        const barrioCliente = (conv.barrio || "").trim().toLowerCase();
        const barrioMatch = barriosData.find((b) =>
          (b.nombre_barrio || "").toLowerCase().includes(barrioCliente),
        );

        const domicilio = barrioMatch?.precio_domicilio || 0;
        if (!barrioMatch) {
          console.warn(
            `⚠️ Barrio no reconocido: "${conv.barrio}". Se asigna domicilio = 0`,
          );
        } else {
          console.log(
            `✅ Barrio reconocido: "${barrioMatch.nombre_barrio}" -> $${domicilio}`,
          );
        }

        // 2. Obtener todos los platos y buscar coincidencia aproximada
        const { data: menuData = [], error: menuError } = await supabase
          .from("platos")
          .select("id, nombre_plato, precio");

        if (menuError)
          console.warn("⚠️ Error al obtener platos:", menuError.message);

        const platosCliente = Array.isArray(conv.platos) ? conv.platos : [];
        const platosDetallados = platosCliente.map((nombre) => {
          const nombreCliente = (nombre || "").toLowerCase();
          const match = menuData.find((p) =>
            (p.nombre_plato || "").toLowerCase().includes(nombreCliente),
          );
          if (!match) {
            console.warn(
              `⚠️ Plato no reconocido: "${nombre}". Se guardará con precio 0`,
            );
          } else {
            console.log(
              `✅ Plato reconocido: "${match.nombre_plato}" -> $${match.precio}`,
            );
          }
          return {
            plato_id: match?.id || null,
            nombre_plato: match?.nombre_plato || nombre,
            precio: match?.precio || 0,
            cantidad: 1,
          };
        });

        // 3. Calcular subtotal y total
        const subtotal = platosDetallados.reduce(
          (acc, p) => acc + p.precio * p.cantidad,
          0,
        );
        const total = subtotal + domicilio;

        // 4. Insertar pedido
        const { data: pedido, error: pedidoError } = await supabase
          .from("pedidos")
          .insert([
            {
              nombre: conv.nombre,
              direccion: conv.direccion,
              telefono: conv.telefono,
              domicilio,
              subtotal,
              total,
              estado: "pendiente",
              barrio: conv.barrio,
              observacion: mensaje,
              created_at: new Date().toISOString(),
            },
          ])
          .select()
          .single();

        if (pedidoError) {
          console.error("❌ Error creando pedido:", pedidoError.message);
          // opcional: notificar al admin o al cliente
          await enviarWhatsApp(
            telefono,
            `❌ Ocurrió un error al crear tu pedido. Intenta de nuevo.`,
          );
          break;
        }

        console.log("✅ Pedido guardado en tabla pedidos:", pedido);

        // 5. Insertar detalle de platos (si hay platos)
        if (platosDetallados.length > 0) {
          const inserts = platosDetallados.map((plato) =>
            supabase.from("pedido_detalle").insert([
              {
                pedido_id: pedido.id,
                plato_id: plato.plato_id,
                nombre_plato: plato.nombre_plato,
                precio: plato.precio,
                cantidad: plato.cantidad,
              },
            ]),
          );

          // Ejecutar inserciones y capturar errores por si alguno falla
          const results = await Promise.all(inserts);
          results.forEach((r, i) => {
            if (r.error) {
              console.error(
                `❌ Error insertando detalle (plato ${i}):`,
                r.error.message,
              );
            }
          });

          console.log("✅ Intento de guardado en pedido_detalle completado");
        } else {
          console.log("ℹ️ No hay platos para insertar en pedido_detalle");
        }

        // 6. Confirmación al cliente con desglose
        await enviarWhatsApp(
          telefono,
          `✅ Pedido confirmado!\n` +
            `Nombre: ${conv.nombre}\n` +
            `Dirección: ${conv.direccion}\n` +
            `Barrio: ${conv.barrio}\n` +
            `Platos:\n${platosDetallados.map((p) => `- ${p.nombre_plato} x${p.cantidad} $${p.precio}`).join("\n")}\n` +
            `Observación: ${mensaje || "-"}\n\n` +
            `Subtotal: $${subtotal}\n` +
            `Domicilio: $${domicilio}\n` +
            `Total: $${total}`,
        );
      } catch (err) {
        console.error("❌ Error en case 'confirmacion':", err);
        // No dejar que el proceso se caiga; notificar al cliente si quieres
        try {
          await enviarWhatsApp(
            telefono,
            `❌ Ocurrió un error procesando tu pedido. Por favor intenta de nuevo.`,
          );
        } catch (e) {
          console.error("❌ Error enviando notificación de fallo:", e);
        }
      }

      break;
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
