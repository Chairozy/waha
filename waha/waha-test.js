// docker run -it --env-file "E:/nodedocs/wa7.0.0/.envwaha" -v E:/nodedocs/wa7.0.0/public:/app/.media -v E:/nodedocs/wa7.0.0/.sessions:/app/.sessions --rm -p 3403:3000 --name waha devlikeapro/waha
// docker run -it -e "WHATSAPP_DEFAULT_ENGINE=GOWS" devlikeapro/waha
// docker run -it -p 3000:3000 devlikeapro/waha


const { WhatsAppHttpApi } = require("./WhatsAppHttpApi");

const fs = require('fs');
const mime = require("mime-types");
const moment = require('moment');
const axios = require('axios');

const http = require("http");
const https = require("https");
const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const app = express();
const bodyParser = require('body-parser');

(async () => {

const service = {
  session: 4001,
  jwt_token: "123456",
  waha_session: ""
}

const systemJwt = "12345";
const server = http.createServer(app);

const mediaUrlPrefix = 'media';

// app.use('/'+mediaUrlPrefix, express.static('public'))
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json({
  limit: '200mb'
}))
app.use(bodyParser.raw())
app.use(bodyParser.text())
app.use(fileUpload());

// app.use(cors({
//     methods: "*",
//     preflightContinue: false,
// }));

app.use((req, res, next) => {
  console.log("any request")
  const authorization = req.get('Authorization');
  if (req.method != "POST") {
    res.status(405).send('Method Not Allowed');
  } else if (typeof authorization === 'string'
    && ((service.jwt_token && authorization.replace(/^[Bb]earer\s*/g, '') == service.jwt_token)
      || (systemJwt && authorization.replace(/^[Bb]earer\s*/g, '') == systemJwt))
  ) {
    next();
  } else {
    res.status(401).send('JWT Token Required or Invalid');
  }
});

const whatsapp = await (async () => {
  let attempt = 0;
  const whatsapp = new WhatsAppHttpApi(
    "001-3000-515aa2bca14c412db9642ca9be230ba4",
    `${'http://localhost'}`
  );
  whatsapp.session.name = "default";

  while (attempt < 3) {
    try {
      const { data } = await whatsapp.apiSession().get();
      console.log(data.status);
      if (data.status == whatsapp.SESSION_STATUS.STOPPED || data.status == whatsapp.SESSION_STATUS.FAILED) {
        await whatsapp.apiSession().start();
      }else{
        return whatsapp;
      }
    } catch (err) {
      console.log(err);
      attempt++;
    }
  }
})()

whatsapp.ev.on('session.status', async ({ status }) => {
  console.log({ event: 'session.status', status });
  if (status == whatsapp.SESSION_STATUS.STOPPED || status == whatsapp.SESSION_STATUS.FAILED) {
    const authPhone = await whatsapp.apiSession().me();
    const loggedOut = Boolean(authPhone.data.id);
    if (loggedOut) {
      service.phone_auth = null;
    }
    await whatsapp.apiSession().restart();
  }else if (status == whatsapp.SESSION_STATUS.SCAN_QR_CODE) {
    service.phone_auth = null;
    whatsapp.apiSession().qr().then(res => fs.writeFileSync("./qr.png", res.data));
  }else if (status == whatsapp.SESSION_STATUS.WORKING) {
    service.phone_auth = whatsapp.user.id;
    service.latest_phone_auth = whatsapp.user.id;
    // socketEmit('user', whatsapp.user);
  }
})

whatsapp.ev.on('message.any', async (data) => {
	console.log({ event: 'message.any', data});
});

app.post("/api/reciever/reload", async (req, res) => {
  console.log("/api/reciever/reload")
  res.status(200).json({ message: "Reciever triggered reload", code: 100 });
})

// whatsapp.apiSession().config({
//   webhooks: []
// });
// whatsapp.apiSession().restart();
// whatsapp.apiSession().requestCode("6289634858618").then((res) => console.log(res.data));
// whatsapp.apiSession().qr().then(res => fs.writeFileSync("./qr.png", res.data))
// whatsapp.apiContact().all().then(res => console.log(res.data))
// whatsapp.apiContact().exists("08969696696969"/).then(res => console.log(res.data)).catch()
// whatsapp.apiGroup().all().then(res => console.log(res.data))
// whatsapp.apiGroup().get("3242348937289@g.us").then(res => console.log(res.data)).catch()
// console.log(await whatsapp.apiGroup().get("120363422212602399@g.us").then(res => res.data).catch(err => {}))
// whatsapp.apiSession().me().then(res => console.log(res.data))
// server.listen(service.session, async () => {
//   console.log('listening on ' + service.session);
//   // await whatsapp.connect();
//   try {
//     whatsapp.listenEvents();
//   } catch (err){console.log(err)}
// });

})();