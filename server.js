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
  process.env.SUPABASE_KEY,
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

// Webhook para recibir mensajes entrantes
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message) {
      const numero = message.from; // número del cliente
      const texto = message.text?.body; // texto entrante

      console.log("Mensaje recibido:", texto);

      // Respuesta automática mínima
      await enviarWhatsApp(numero, "Hola 👋, ¿cuál es tu nombre?");
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error en webhook:", err);
    res.sendStatus(500);
  }
});


app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
