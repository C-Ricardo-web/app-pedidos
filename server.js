const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// Conexión a Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Rutas para tus páginas
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/cocina', (req, res) => {
  res.sendFile(path.join(__dirname, 'cocina.html'));
});

app.get('/domiciliario', (req, res) => {
  res.sendFile(path.join(__dirname, 'domiciliario.html'));
});

// Endpoint para crear pedido con columnas reales
app.post('/pedido', async (req, res) => {
  const {
    nombre,
    direccion,
    telefono,
    domicilio,
    subtotal,
    total,
    estado,
    barrio,
    observacion
  } = req.body;

  const { data, error } = await supabase
    .from('pedidos')
    .insert([{
      nombre,
      direccion,
      telefono,
      domicilio,
      subtotal,
      total,
      estado,
      barrio,
      observacion
    }]);

  if (error) {
    console.error("Error Supabase:", error);
    return res.status(500).json({ error: error.message });
  }

  // WhatsApp: aquí puedes armar el texto con los campos que quieras
  await enviarWhatsApp(
    `Nuevo pedido de ${nombre} (${barrio})\n` +
    `Dirección: ${direccion}\nTel: ${telefono}\nTotal: $${total}`
  );

  res.json({ mensaje: 'Pedido creado y notificado', pedido: data });
});


// Webhook de verificación
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = "pedidos123"; // inventado, ponlo igual en Meta Developers

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log("Webhook verificado correctamente");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// Webhook para recibir mensajes entrantes
app.post('/webhook', (req, res) => {
  const body = req.body;
  console.log("Mensaje entrante:", JSON.stringify(body, null, 2));

  // Aquí puedes procesar el mensaje recibido
  res.sendStatus(200);
});

// Función para enviar mensajes a WhatsApp (usando fetch nativo de Node 18+)
async function enviarWhatsApp(texto) {
  try {
    await fetch(`https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: process.env.WHATSAPP_DESTINO, // número destino en formato internacional
        type: 'text',
        text: { body: texto }
      })
    });
    console.log("Mensaje enviado a WhatsApp:", texto);
  } catch (err) {
    console.error("Error enviando WhatsApp:", err);
  }
}

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});