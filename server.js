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
  const { nombre, direccion, telefono, barrio, observacion, platos } = req.body;

  // 1. Obtener costo de domicilio desde Supabase
  const { data: barrioData } = await supabase
    .from('barrios')
    .select('precio_domicilio')
    .eq('nombre_barrio', barrio)
    .single();

  const domicilio = barrioData?.precio_domicilio || 0;

  // 2. Calcular subtotal y total en servidor
  const subtotal = platos.reduce((acc, p) => acc + p.precio, 0);
  const total = subtotal + domicilio;

  // 3. Insertar pedido
  const { data: pedido, error } = await supabase
    .from('pedidos')
    .insert([{ nombre, direccion, telefono, domicilio, subtotal, total, estado: 'pendiente', barrio, observacion }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // 4. Insertar detalle de platos
  for (const plato of platos) {
    await supabase.from('pedido_detalle').insert([{ pedido_id: pedido.id, nombre_plato: plato.nombre_plato, precio: plato.precio }]);
  }

  // 5. Enviar confirmación al cliente por WhatsApp
  await enviarWhatsApp(telefono, `Hola ${nombre}, tu pedido fue recibido.\nTotal: $${total}\nEstado: pendiente.`);

  res.json({ mensaje: 'Pedido creado y notificado', pedido });
});

// Ajustar función enviarWhatsApp para recibir el número del cliente
async function enviarWhatsApp(numero, texto) {
  await fetch(`https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: numero,
      type: 'text',
      text: { body: texto }
    })
  });
}



// Webhook de verificación
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = "pedidos123"; // igual en Meta Developers

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

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});