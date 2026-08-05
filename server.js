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

  // --- Funciones auxiliares (declarar UNA vez, antes del switch) ---
  const normalizar = (texto) => {
    if (!texto || typeof texto !== "string") return "";
    return texto
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // elimina acentos
      .replace(/\s+/g, " ")
      .trim();
  };

  const singularizar = (texto) => {
    if (!texto || typeof texto !== "string") return texto;
    // regla simple: quitar 's' final si existe y la palabra tiene más de 2 caracteres
    return texto.endsWith("s") && texto.length > 2 ? texto.slice(0, -1) : texto;
  };

  // --- Flujo conversacional (reemplaza tu switch actual por este) ---
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
      // Normalizar entrada del usuario
      const barrioInputNormalizado = normalizar(mensaje);

      // Buscar coincidencia flexible en tabla barrios (no listar barrios en WA)
      const { data: barrioMatch } = await supabase
        .from("barrios")
        .select("nombre_barrio")
        .ilike("nombre_barrio", `%${barrioInputNormalizado}%`)
        .maybeSingle();

      if (!barrioMatch) {
        await enviarWhatsApp(
          telefono,
          "No reconocí el barrio que escribiste. Por favor intenta de nuevo con el nombre oficial.",
        );
        return res.sendStatus(200); // detener flujo hasta que el cliente corrija
      }

      // Guardar barrio oficial y avanzar a platos
      await supabase
        .from("conversaciones")
        .update({ barrio: barrioMatch.nombre_barrio, estado: "platos" })
        .eq("id", conv.id);

      console.log("📌 Estado cambiado a: platos");

      // Obtener menú disponible (para mostrar en WA)
      const { data: menu, error: menuError } = await supabase
        .from("menu")
        .select("nombre_plato, precio")
        .eq("disponible", true);

      if (menuError) {
        console.error("❌ Error cargando menú:", menuError.message);
        await enviarWhatsApp(telefono, "Error interno al cargar el menú.");
        return res.sendStatus(200);
      }

      const listaPlatos = menu
        .map((p) => `${p.nombre_plato} ($${p.precio})`)
        .join("\n");

      await enviarWhatsApp(
        telefono,
        "¿Qué plato deseas? 🍔🍕 (puedes escribir varios separados por coma)\n\nMenú disponible:\n" +
          listaPlatos,
      );
      break;

    case "platos":
      // Obtener menú disponible (datos completos)
      const { data: menuPlatos, error: menuError2 } = await supabase
        .from("menu")
        .select("id, nombre_plato, precio")
        .eq("disponible", true);

      if (menuError2) {
        console.error("❌ Error cargando menú:", menuError2.message);
        await enviarWhatsApp(telefono, "Error interno al cargar el menú.");
        return res.sendStatus(200);
      }

      // Parsear mensaje del cliente (varios separados por coma)
      const items = (mensaje || "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const platos = [];

      for (const item of items) {
        const match = item.match(/^(\d+)\s+(.*)$/); // ej. "4 arepa rellena"
        let cantidad = 1;
        let nombrePlato = item;

        if (match) {
          cantidad = parseInt(match[1], 10) || 1;
          nombrePlato = match[2];
        }

        // Normalizar y buscar con tolerancia
        let nombreNormalizado = normalizar(nombrePlato);
        let platoData = menuPlatos.find((p) =>
          normalizar(p.nombre_plato).includes(nombreNormalizado),
        );

        // Si no encuentra, probar singular (ej. "arepas" -> "arepa")
        if (!platoData) {
          const singular = singularizar(nombreNormalizado);
          if (singular !== nombreNormalizado) {
            platoData = menuPlatos.find((p) =>
              normalizar(p.nombre_plato).includes(singular),
            );
            nombreNormalizado = singular;
          }
        }

        // Si aún no encuentra, intentar coincidencia por palabras (split)
        if (!platoData) {
          const palabras = nombreNormalizado.split(" ").filter(Boolean);
          if (palabras.length > 1) {
            // buscar si todos los tokens aparecen en el nombre del plato
            platoData = menuPlatos.find((p) => {
              const np = normalizar(p.nombre_plato);
              return palabras.every((t) => np.includes(t));
            });
          }
        }

        if (platoData) {
          platos.push({
            plato_id: platoData.id,
            nombre_plato: platoData.nombre_plato,
            precio: platoData.precio,
            cantidad,
          });
        } else {
          console.warn(`⚠️ Plato no reconocido: "${item}"`);
        }
      }

      // Validar que haya al menos un plato válido
      if (platos.length === 0) {
        await enviarWhatsApp(
          telefono,
          "No entendí los platos que pediste. Por favor escribe el nombre tal como aparece en el menú:\n" +
            menuPlatos
              .map((p) => `${p.nombre_plato} ($${p.precio})`)
              .join("\n"),
        );
        return res.sendStatus(200); // detener flujo
      }

      // Guardar platos en conversación y avanzar
      await supabase
        .from("conversaciones")
        .update({ platos, estado: "confirmacion" })
        .eq("id", conv.id);

      console.log("📌 Estado cambiado a: confirmacion");
      await enviarWhatsApp(telefono, "¿Quieres añadir alguna observación? ✍️");
      break;

    case "confirmacion":
      // Actualizar conversación a finalizado
      await supabase
        .from("conversaciones")
        .update({ observacion: mensaje, estado: "finalizado" })
        .eq("id", conv.id);

      console.log("📌 Estado cambiado a: finalizado");

      // 1. Obtener costo de domicilio desde tabla barrios
      const barrioCliente = (conv.barrio || "").trim();
      const { data: barrioPrecio } = await supabase
        .from("barrios")
        .select("precio_domicilio")
        .ilike("nombre_barrio", `%${normalizar(barrioCliente)}%`)
        .maybeSingle();

      const domicilio = barrioPrecio?.precio_domicilio || 0;
      if (!barrioPrecio) {
        console.warn(
          `⚠️ Barrio no reconocido: "${conv.barrio}". Se asigna domicilio = 0`,
        );
      }

      // 2. Obtener info de platos desde tabla menu
      const platosDetallados = [];
      for (const plato of conv.platos || []) {
        // Normalizar nombre del plato guardado
        const nombreNormalizado = normalizar(plato.nombre_plato);

        // Buscar coincidencia en tabla menu (tolerante)
        const { data: platoData } = await supabase
          .from("menu")
          .select("id, nombre_plato, precio")
          .ilike("nombre_plato", `%${nombreNormalizado}%`)
          .maybeSingle();

        if (platoData) {
          platosDetallados.push({
            plato_id: platoData.id,
            nombre_plato: platoData.nombre_plato,
            precio: platoData.precio,
            cantidad: plato.cantidad || 1,
          });
        } else {
          // Si no se encuentra, conservar lo que el cliente escribió
          platosDetallados.push({
            plato_id: plato.plato_id || null,
            nombre_plato: plato.nombre_plato,
            precio: plato.precio || 0,
            cantidad: plato.cantidad || 1,
          });
          console.warn(`⚠️ Plato no reconocido: "${plato.nombre_plato}"`);
        }
      }

      // 3. Calcular subtotal y total
      const subtotal = platosDetallados.reduce(
        (acc, p) => acc + (p.precio || 0) * (p.cantidad || 1),
        0,
      );
      const total = subtotal + domicilio;

      // 4. Insertar pedido
      const { data: pedido, error } = await supabase
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

      if (error) {
        console.error("❌ Error creando pedido:", error.message);
      } else {
        console.log("✅ Pedido guardado en tabla pedidos:", pedido);

        // 5. Insertar detalle de platos
        await Promise.all(
          platosDetallados.map((plato) =>
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
        console.log("✅ Platos guardados en pedido_detalle");
      }

      // 6. Confirmación al cliente
      await enviarWhatsApp(
        telefono,
        `✅ Pedido confirmado!\n` +
          `Cliente: ${conv.nombre}\n` +
          `Dirección: ${conv.direccion}\n` +
          `Barrio: ${conv.barrio}\n` +
          `Platos: ${platosDetallados.map((p) => `${p.cantidad} ${p.nombre_plato}`).join(", ")}\n` +
          `Obs: ${mensaje || "Ninguna"}\n` +
          `Subtotal: $${subtotal} | Domicilio: $${domicilio}\n` +
          `TOTAL: $${total}`,
      );

      break;
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
