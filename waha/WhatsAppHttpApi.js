require('dotenv').config({path:__dirname+'/./../.env'});
const { spawn } = require("child_process");
const axios = require('axios');
const { EventEmitter } = require("node:events");
const WebSocket = require('ws');
const mime = require("mime-types");

const SESSION_END_POINTS = [
  "auth", "profile", "chats", "channels", "status", "contacts/{chatId}", "lids", "groups", "presence", "events", "media"
]

class SendContent {
  static create(chatId = "") {
    return new SendContent(chatId);
  }

  constructor(chatId = "") {
    this._fields = new Set();
    if (chatId) this._fields.add("chatId");
    this._contacts = [];
    this._content = {
      chatId,
      reply_to: undefined,
      messageId: undefined,

      linkPreview: false,
      // linkPreviewHighQuality: true, // to enable high-quality link preview (requires additional upload to WA servers)
      // preview: {
      //   url: "https://github.com/",
      //   title: "Your Title",
      //   description: "Check this out, this is a custom link preview!",
      //   image: {
      //     "url": "https://github.com/devlikeapro/waha/raw/core/examples/waha.jpg"
      //   }
      // },

      file: {
        mimetype: undefined,
        filename: undefined, // optional
        data: undefined, // if use data remove url field
        url: undefined, // if use url remove data field
      },
      convert: false, // field for video and audio,
      asNote: false, // aka video note, rounded video, similar of voice note

      caption: null, // if file available use caption instead
      text: null,
      mentions: [],

      contacts: [],

      title: undefined,
      latitude: undefined,
      longitude: undefined
    }
  }

  clone() {
    const cloneContent = new SendContent();
    cloneContent._fields = new Set([...this._fields.values()]);
    cloneContent._content = JSON.parse(JSON.stringify(this._content));
    cloneContent._contacts = JSON.parse(JSON.stringify(this._contacts));
    return cloneContent;
  }

  getContent() {
    const content = {}
    this._fields.forEach((val) => {
      if (val === 'file') {
        content[val] = {};
        if (this._content[val].mimetype !== undefined) content[val].mimetype = this._content[val].mimetype;
        if (this._content[val].filename !== undefined) content[val].filename = this._content[val].filename;
        if (this._content[val].data !== undefined) content[val].data = this._content[val].data;
        if (this._content[val].url !== undefined) content[val].url = this._content[val].url;
      }else if (val === 'contacts') {
        content[val] = [];
        for (const contact of this._contacts) {
          if (contact.vcard) {
            content[val].push(contact);
            continue;
          }
          let vcard = 'BEGIN:VCARD\n'
            + 'VERSION:3.0\n';
          contact.fullname && (vcard += 'FN:'+contact.fullname+'\n');
          contact.nickname && (vcard += 'NICKNAME:'+contact.nickname+'\n');
          contact.organization && (vcard += 'ORG:'+contact.organization+'\n');
          contact.birth_day && (vcard += 'BDAY:'+contact.birth_day+'\n');
          if (contact.email) {
            const email = contact.email.split(";")
            for(let i in email) {
              if (email[i]) {
                vcard += 'EMAIL:'+email[i]+'\n';
              }
            }
          }
          if (contact.url) {
            const url = contact.url.split(";")
            for(let i in url) {
              if (url[i]) {
                vcard += 'URL:'+url[i]+'\n';
              }
            }
          }
          if (contact.whatsapp) {
            const whatsapp = contact.whatsapp.split(";")
            for(let i in whatsapp) {
              if (whatsapp[i]) {
                const whatsappJid = phoneNumberFormatter(whatsapp[i]).split("@")[0]
                vcard += 'TEL;type=CELL;type=VOICE;waid='+whatsappJid+':'+whatsapp[i]+'\n';
              }
            }
          }
          if (contact.telephone) {
            const telephone = contact.telephone.split(";")
            for(let i in telephone) {
              if (telephone[i]) {
                vcard += 'TEL;type=CELL;type=VOICE:'+telephone[i]+'\n';
              }
            }
          }
          if (contact.address_home) {
            for(let i in contact.address_home) {
              if (contact.address_home[i]) {
                vcard += 'ADR;TYPE=home:;;'+contact.address_home[i]+'\n';
              }
            }
          }
          if (contact.address_work) {
            for(let i in contact.address_work) {
              if (contact.address_work[i]) {
                vcard += 'ADR;TYPE=work:;;'+contact.address_work[i]+'\n';
              }
            }
          }
          vcard += 'END:VCARD';
          content[val].push({ vcard });
        }
      }else{
        content[val] = this._content[val];
      }
    })
    return Object.keys(content).length && content || null;
  }

  linkPreview(linkPreview = true) {
    this._fields.add("linkPreview");
    this._content.linkPreview = linkPreview;
    return this;
  }

  chat(chatId = "") {
    this._fields.add("chatId");
    this._content.chatId = chatId;
    return this;
  }

  message(message, linkPreview = true) {
    this._fields.add("text");
    this._fields.add("caption");
    if (linkPreview) this.linkPreview();
    this._content.text = message;
    this._content.caption = message;
    return this;
  }

  mentions(...mentions) {
    this._fields.add("mentions");
    if (!mentions.length && this._content.text) {
      this._content.text = this._content.text.replace(/@@\+?\d+/g, (substring) => {
        let formatted = phoneNumberFormatter(substring.substring(2));
        mentions.push(formatted);
        return "@" + formatted.split("@")[0];
      });
      this._content.caption = this._content.text;
    }
    this._content.mentions = mentions;
    return this;
  }

  reply(reply_to = "") {
    this._fields.add("reply_to");
    this._content.reply_to = reply_to;
    return this;
  }

  forward(messageId = "") {
    this._fields.add("messageId");
    this._content.messageId = messageId;
    return this;
  }

  location(title = "", latitude = 0, longitude = 0) {
    this._fields.add("title");
    this._fields.add("latitude");
    this._fields.add("longitude");
    this._content.title = title;
    this._content.latitude = latitude;
    this._content.longitude = longitude;
    return this;
  }

  locationValidation() {
    const content = {
      title: this._content.title,
      latitude: this._content.latitude,
      longitude: this._content.longitude,
    }
    const result = {}
    const contentKeys = Object.keys(content);
    if ((contentKeys.includes('latitude') ? 1 : 0) + (contentKeys.includes('longitude') ? 1 : 0) == 1) throw "latitude and longitude must exist together";
    if (contentKeys.includes('latitude') && contentKeys.includes('longitude')) {
      if (typeof content.latitude !== 'number') throw "latitude must number"
      if (!content.latitude) throw "latitude cannot be 0"
      if (typeof content.longitude !== 'number') throw "longitude must number"
      if (!content.longitude) throw "longitude cannot be 0"
      result.latitude = content.latitude;
      result.longitude = content.longitude;
    }
    if (contentKeys.includes('title')) {
      if (typeof content.title !== 'string') throw "title must string"
      if (!content.title) throw "title is required"
      result.title = content.title;
    }
    if (Object.keys(result).length <= 0 || (Object.keys(result).length == 1 && result.jpegThumbnail)) {
      throw "location fields is not correct"
    }
    return this;
  }

  contacts(...contacts) {
    this._contacts.length = 0;
    this._fields.add("contacts");
    for (const contact of contacts) {
      if (typeof contact === "object") {
        this._contacts.push(contact);
      }
    }
    return this;
  }

  contactValidation() {
    for (const content of this._contacts) {

      const contentKeys = Object.keys(content);
      if (!contentKeys.includes('fullname')) {
        throw "fullname is required"
      }else if(typeof content.fullname !== 'string') {
        throw "fullname must string"
      }
  
      if (contentKeys.includes('nickname')) {
        if (typeof content.nickname !== 'string') throw "nickname must string";
        if (!content.nickname) throw "nickname is required";
      }
  
      if (contentKeys.includes('organization')) {
        if (typeof content.organization !== 'string') throw "organization must string";
        if (!content.organization) throw "organization is required";
      }
  
      if (contentKeys.includes('birth_day')) {
        if (typeof content.birth_day !== 'string') throw "birth_day must string";
        if (!content.birth_day) throw "birth_day is required";
      }
  
      if (contentKeys.includes('email')) {
        if (typeof content.email !== 'string') throw "email must string";
        if (!content.email) throw "email is required";
      }
  
      if (contentKeys.includes('url')) {
        if (typeof content.url !== 'string') throw "url must string";
        if (!content.url) throw "url is required";
      }
      
      if (contentKeys.includes('whatsapp')) {
        if (typeof content.whatsapp !== 'string') throw "whatsapp must string";
        if (!content.whatsapp) throw "whatsapp is required";
      }
  
      if (contentKeys.includes('telephone')) {
        if (typeof content.telephone !== 'string') throw "telephone must string";
        if (!content.telephone) throw "telephone is required";
      }
  
      if (contentKeys.includes('address_home')) {
        if (content.address_home && typeof content.address_home === 'string') content.address_home = [content.address_home]
        if (!Array.isArray(content.address_home)) throw "address_home must array string";
        for(let i in content.address_home) {
          if (!content.address_home[i]) {
            throw "address_home value is required";
          }
        }
      }
  
      if (contentKeys.includes('address_work')) {
        if (content.address_work && typeof content.address_work === 'string') content.address_work = [content.address_work]
        if (!Array.isArray(content.address_work)) throw "address_work must array string";
        for(let i in content.address_work) {
          if (!content.address_work[i]) {
            throw "address_work value is required";
          }
        }
      }
    }
    return this
  }

  file(data, filename, mimetype = "application/octet-stream") {
    this._fields.add("file");
    if (data.startsWith('http')) {
      this._content.file.url = data;
    }else{
      this._content.file.data = data;
    }

    if (filename) {
      this._content.file.filename = filename;
    }

    if (mimetype) {
      this._content.file.mimetype = mimetype;
    }

    return this;
  }

  image(data, filename = "", mimetype = "image/jpeg") {
    mimetype = mime.lookup(filename) || mimetype;
    return this.file(data, filename, mimetype);
  }

  video(data, filename = "", mimetype = "video/mp4") {
    mimetype = mime.lookup(filename) || mimetype;
    return this.convert(mimetype !== "video/mp4").file(data, filename, mimetype);
  }

  audio(data, filename = "", mimetype = "audio/ogg; codecs=opus") {
    mimetype = mime.lookup(filename) || mimetype;
    return this.convert(mimetype !== "audio/ogg; codecs=opus").file(data, filename, mimetype);
  }

  convert(convert = true) {
    this._fields.add("convert");
    this._content.convert = convert;
    return this;
  }

  asNote() {
    this._fields.add("asNote");
    this._content.asNote = true;
    return this;
  }
}

class WhatsAppHttpApi {
  SESSION_STATUS = {
    STOPPED: "STOPPED",
    STARTING: "STARTING",
    SCAN_QR_CODE: "SCAN_QR_CODE",
    WORKING: "WORKING",
    FAILED: "FAILED"
  }

  static dockerCreate (id, port, apiKey = "") {
    return new Promise(resolve => {
      let result = {id, port, apiKey, workerId: "", directory: ""}
      const child = spawn(`${process.env.APP_WH_DIRECTORY || "."}/create_account.sh`, [id, port, apiKey])
      
      child.stdout.on("data", (data) => {
        console.log(`stdout: ${data}`);
        data = `${data}`;
        if (typeof data === "string") {
          if (data.startsWith("Folder: ")) {
            result.directory = data.split(/: |\n/g)[1]
          }else if (data.startsWith("Port: ")) {
            result.port = data.split(/: |\n/g)[1]
          }else if (data.startsWith("Worker ID: ")) {
            result.workerId = data.split(/: |\n/g)[1]
          }else if (data.startsWith("API Key: ")) {
            result.apiKey = data.split(/: |\n/g)[1]
          }
        }
      });
    
      child.stderr.on("data", (data) => {
        console.error(`stderr: ${data}`);
      });
      
      child.on("close", (code) => resolve(result));
    })
  }
  
  dockerStart () {
    return new Promise(resolve => {
      const child = spawn(`${process.env.APP_WH_DIRECTORY || "."}/start_docker.sh`, [this.id])
      const status = {}

      child.stdout.on("data", (data) => {
        data = `${data}`;
        if (data.includes("[SUCCESS]")) {
          status.success = data.split(/\[SUCCESS\] |\n/g)[1];
        }else if(data.includes("[ERROR]")) {
          status.error = data.split(/\[ERROR\] |\n/g)[1];
        }
      });

      child.stderr.on("data", (data) => {
        data = `${data}`;
        if (data.includes("Container") && data.includes("Started")) {
          status.status = "Started";
        }else if (data.includes("Container") && data.includes("Running")) {
          status.status = "Running";
        }
      });
      
      child.on("close", (code) => resolve(status));
    })
  }

  dockerStop () {
    return new Promise(resolve => {
      const child = spawn(`${process.env.APP_WH_DIRECTORY || "."}/stop_docker.sh`, [this.id])
      const status = { status: "Gone" }

      child.stdout.on("data", (data) => {
        data = `${data}`;
        if (data.includes("[+] Running 1/1") || data.includes("[+] Running 0/1")) {
          status.status = "Removed";
        }else if (data.includes("[SUCCESS]")) {
          status.success = data.split(/\[SUCCESS\] |\n/g)[1];
        }else if(data.includes("[ERROR]")) {
          status.error = data.split(/\[ERROR\] |\n/g)[1];
        }
      });

      child.stderr.on("data", (data) => {
        data = `${data}`;
        if (data.includes("Container") && data.includes("Removed")) {
          status.status = "Removed";
        }
      });
      
      child.on("close", (code) => resolve(status));
    })
  }

  dockerDelete () {
    return new Promise(resolve => {
      this.dockerStop();
      const child = spawn(`rm -rf ${process.env.APP_WH_DIRECTORY || "."}/accounts/${this.session.name}`);
      child.on("close", (code) => resolve());
    })
  }

  constructor(session, docker_host) {
    const [id, port, api_key] = session.split("-");
    this.id = parseInt(id);
    this.ev = new EventEmitter();
    this.useSendSeen = false;
    this.session = {
      name: session,
      status: "STOPPED",
      statuses: []
    };
    this.user = {
      id: "", //"11111111111@c.us
      lid: "", //"123123@lid"
      jid: "", //"123123:123@s.whatsapp.net",
      pushName: "", //"pushname"
      name: "" //"pushname"
    }
    this.api_key = api_key;
    this.axios = axios.create({
      baseURL: `${docker_host}:${port}/`,
      headers: { "X-Api-Key": this.api_key, "Content-Type": "application/json" }
    });
    this.axiosApi = this.axios.create({
      baseURL: `${docker_host}:${port}/api/`,
    })
    this.axiosFile = this.axios.create({
      responseType: 'arraybuffer'
    })
    this.axiosApiFile = this.axiosApi.create({
      responseType: 'arraybuffer'
    })
    this.qr = undefined;

    this.listenEvents = () => {
      const wsurl = `${docker_host.replace("http://", "ws://").replace("https://", "wss://")}:${port}/ws?x-api-key=${this.api_key}&session=${this.session.name}&events=session.status&events=message.any&events=group.v2.join&events=group.v2.leave`;
      const ws = new WebSocket(wsurl);

      ws.on('open', () => {
        console.log('✓ Connected to WebSocket server');
      });

      ws.on('message', async (message) => {
        const event = JSON.parse(message.toString('utf-8'));
        if (event.session == this.session.name) {
          this.user = event.me;
          if (this.user) this.user.name = event.me?.pushName;
          if (event.event == "session.status") {
            this.session.status = event.payload.status;
            this.session.statuses = event.payload.statuses;
            if (this.session.status == this.SESSION_STATUS.SCAN_QR_CODE) {
              const { data } = await this.apiSession().qr();
              this.qr = data.toString("base64");
            }else{
              this.qr = undefined;
            }
          }
          this.ev.emit(event.event, event.payload, event.timestamp, event.metadata);
        }
      });

      ws.on('close', () => {
        console.log('✗ Disconnected from server');
      });

      ws.on('error', (error) => {
        console.error('✗ WebSocket error:', error);
      });
    }
  }

  ping() {
    return this.axios.get('ping');
  }

  health() {
    return this.axios.get('health');
  }

  screenshot() {
    return this.axiosApiFile.get('screenshot');
  }

  urlSerialize(url, data = {}) {
    if (SESSION_END_POINTS.find((startStr) => url.startsWith(startStr))) {
      url = "{session}/" + url
    }
    data.session = this.session.name;
    for (let i in data) {
      url = url.replace(`{${i}}`, data[i]);
    }
    return url;
  }

  apiSession() {
    const prefix = "sessions";
    const apiRequest = (action = "", opt = {}) => this.apiRequest(`${prefix}/{session}${(action && "/" || "") + action}`, {}, opt);
    return {
      create: (data = {}) => this.apiRequest(prefix, { name: this.session.name, start: true, ...data }),
      start: () => apiRequest("start"),
      stop: () => apiRequest("stop"),
      logout: () => apiRequest("logout"),
      restart: () => apiRequest("restart"),
      delete: () => apiRequest("", { method: "delete" }),
      get: () => apiRequest("", { method: "get" }),
      me: () => apiRequest("me", { method: "get" }),
      all: () => this.apiRequest(prefix , {}, { method: "get" }),
      qr: () => this.apiRequest("auth/qr" , { }, { method: "get", responseType: "arraybuffer" }),
      requestCode: (phoneNumber) => this.apiRequest("auth/request-code" , { phoneNumber }),
      config: (data = {}) => this.apiRequest(`${prefix}/{session}`, {
        config: {
          metadata: {},
          proxy: null,
          debug: false,
          ignore: { status: null, groups: null, channels: null },
          // noweb: { markOnline: true, store: { enabled: true, fullSync: false } },
          // webjs: { tagsEventsOn: false },
          webhooks: [],
          ...data
        }
      }, { method: "put" })
    }
  }

  apiContact() {
    const prefix = "contacts";
    const prefixLid = "lids";
    const apiRequest = (action = "", data = {}, opt = {}) => this.apiRequest(`${prefix}${(action && "/" || "") + action}`, data, opt);

    return {
      all: () => apiRequest("all", {}, { method: "get" }),
      get: () => {},
      exists: (number) => apiRequest("check-exists", { phone: number }, {method: "get"}),
      about: () => {},
      picture: () => {},
      block: () => {},
      unblock: () => {},
      createOrUpdate: () => {},
      lidAll: () => {},
      lidCount: () => {},
      getLid: () => {},
      getPN: (lid) => this.apiRequest(`${prefixLid}/${lid.replace("@", "%40")}`, {}, {method: "get"}),
    }
  }

  apiGroup() {
    const prefix = "groups";
    return {
      new: () => {},
      all: () => this.apiRequest(prefix, { sortBy: 'subject', sortOrder: 'asc' }, {method: "get"}),
      info: () => {},
      join: () => {},
      count: () => {},
      refresh: () => {},
      get: (jid) => this.apiRequest(`${prefix}/${jid}`, {}, {method: "get"}),
      delete: () => {},
      leave: () => {},
      getPicture: () => {},
      setPicture: () => {},
      delPicture: () => {},
      delPicture: () => {},
      setDescription: () => {},
      setSubject: () => {},
      getAdminInfo: () => {},
      setAdminInfo: () => {},
      getAdminMsg: () => {},
      setAdminMsg: () => {},
      invite: () => {},
      inviteRevoke: () => {},
      participants: () => {},
      participantAdd: () => {},
      adminPromote: () => {},
      adminDemote: () => {},
    }
  }

  apiGetImage(url, options = {}) {
    url = this.urlSerialize(url)
    const res = axios({
        method: "get",
        url,
        ...options,
        responseType: 'arraybuffer'
    })
  }

  apiCreate(url, data = {}, options = {}) {
    url = this.urlSerialize(url)
    return this.axiosApi({
      url,
      params: {
        ...(options.method && options.method == "get" ? data : {})
      },
      data: {
        session: this.session.name,
        ...(options.method && options.method == "get" ? data : {})
      },
      ...options,
    })
  }

  apiRequest(url, data = {}, options = {}) {
    url = this.urlSerialize(url)
    return this.axiosApi({ 
      method: "post",
      url,
      params: {
        session: this.session.name,
        ...(options.method && (new Set(["get", "delete", "head"])).has(options.method) ? data : {})
      },
      data: {
        session: this.session.name,
        ...((!options.method || (new Set(["post", "put", "patch"])).has(options.method)) ? data : {})
      },
      ...options,
    })
  }

  async typing(chatId, messageId) {
    if (this.useSendSeen) {
      await this.apiRequest('sendSeen', {
        chatId,
        messageIds: [messageId],
        participant: null,
      });
    }
    await this.apiRequest('startTyping', { chatId });
    await (new Promise(r => setTimeout(r, 1800)));
    await this.apiRequest('stopTyping', { chatId });
  }

  // "file": {
  //   "mimetype": "image/jpeg",
  //   "filename": "filename.jpg",
  //   "url": "https://github.com/devlikeapro/waha/raw/core/examples/waha.jpg"
  // },

  createContent(chatId = "") {
    return SendContent.create(chatId);
  }
  
  // [sendText, sendImage, sendFile, sendVoice, sendVideo, forwardMessage, sendLocation, sendContactVcard]
  async sendMessage(chatId, content = {}) {
    let apiPath = 'sendText';
    content = typeof chatId === 'object' && (chatId instanceof SendContent ? chatId.getContent() : chatId) || content;
    
    const data = {
      chatId: typeof chatId === 'string' ? chatId : content.chatId
    };

    await this.typing(data.chatId, null);

    if (content.text) data.text = content.text;
    if (content.caption) data.caption = content.caption;
    if (content.mentions) data.mentions = content.mentions;
    if (content.reply_to) data.reply_to = content.reply_to;

    if (content.file) {
      data.file = content.file;
      const split_name = content.file.filename.split("."),
        extension = split_name[split_name.length - 1];
      if ((new Set(['tiff','pjp','pjpeg','jfif','tif','gif','svg','bmp','png','jpeg','svgz','jpg','ico','xbm','dib'])).has(extension)) {
        apiPath = "sendImage";
      }else if ((new Set(['m4v', '3gp', 'mov', 'mp4', 'webm', 'mkv', 'avi', 'flv', 'wmv', 'ts'])).has(extension)) {
        apiPath = "sendVideo";
        if (content.convert) data.convert = content.convert;
        else if (extension !== 'mp4') data.convert = true;
        if (content.asNote) data.asNote = content.asNote;
      }else if ((new Set(['ogg', 'aac', 'wav', 'mp3', 'm4a', 'flac', 'aiff', 'aif', 'wma', 'opus', 'caf'])).has(extension)) {
        apiPath = "sendVoice";
        if (content.convert) data.convert = content.convert;
        else if (extension !== 'ogg' && extension !== 'opus') data.convert = true;
      }else{
        apiPath = "sendFile";
      }
    }else if (content.contacts && Array.isArray(content.contacts)) {
      apiPath = "sendContactVcard";
      data.contacts = content.contacts;
    }else if(typeof content.title === "string" && !isNaN(content.latitude) && !isNaN(content.longitude)) {
      apiPath = "sendLocation";
      data.title = content.title;
      data.latitude = content.latitude;
      data.longitude = content.longitude;
    }else if(!content.reply_to && content.messageId) {
      apiPath = "forwardMessage";
      data.messageId = content.messageId;
    }

    return this.apiRequest(apiPath, data);
  }

  // baileys form
  get stating () {
    return {
      STOPPED: "offline",
      STARTING: "beginning",
      SCAN_QR_CODE: "qr",
      WORKING: "online",
      FAILED: "offline"
    }[this.session.status];
  }

  async checkDestination(number) {
    console.log("check number", number)
    if (this.stating == 'online') {
      const tempNumber = number.split("@")[0];
      if (!tempNumber || (typeof tempNumber == 'string' && tempNumber.length < 6)) return false;
      if (this.jid.isJidGroup(number)) {
        const result = await this.apiGroup().get(number).catch(() => {});
        console.log("after fetch group")
        return Boolean(result.data);
      }else{
        const result = await this.apiContact().exists(number).catch(() => {});
        console.log("after fetch number", result.data)
        return Boolean(result.data?.numberExists);
      }
    } else {
      return null;
    }
  }

  jid = {
    /** is the jid */
    isJid: (jid) => jid?.endsWith('@c.us'),
    /** is the jid Meta AI */
    isJidMetaAI: (jid) => jid?.endsWith('@bot'),
    /** is the jid a PN user */
    isPnUser: (jid) => jid?.endsWith('@s.whatsapp.net'),
    /** transform the jid a PN user */
    jidToPn: (jid) => jid?.replace('@c.us', '@s.whatsapp.net'),
    /** is the jid a LID */
    isLidUser: (jid) => jid?.endsWith('@lid'),
    /** transform the lid to a PN user */
    whenLidToPn: (jid) => {
      if (this.jid.isLidUser(jid)) {
        return this.apiContact().getPN(jid)
          .then(res => this.jid.jidToPn(res.data.pn))
          .catch(err => jid);
      }
      return this.jid.jidToPn(jid)
    },
    /** is the jid a broadcast */
    normalizePnFormat: (jid) => this.jid.jidToPn(jid?.replace(/:\d*/g, '')),
    /** is the jid a broadcast */
    isJidBroadcast: (jid) => jid?.endsWith('@broadcast'),
    /** is the jid a group */
    isJidGroup: (jid) => jid?.endsWith('@g.us'),
    /** is the jid the status broadcast */
    isJidStatusBroadcast: (jid) => jid === 'status@broadcast',
    /** is the jid a newsletter */
    isJidNewsletter: (jid) => jid?.endsWith('@newsletter'),
    /** is the jid a hosted PN */
    isHostedPnUser: (jid) => jid?.endsWith('@hosted'),
    /** is the jid a hosted LID */
    isHostedLidUser: (jid) => jid?.endsWith('@hosted.lid'),

    isJidBot: (jid) => jid && /^1313555\d{4}$|^131655500\d{2}$/.test(jid.split('@')[0]) && jid.endsWith('@c.us')
  }
}

function phoneNumberFormatter(number) {
  let formatted = number.replace(/^\s*|\s*$/g, '');
  "".replace()
  if (formatted.endsWith('@g.us') || formatted.endsWith('@c.us') || formatted.endsWith('@s.whatsapp.net')) {
    return formatted.replace('@s.whatsapp.net', '@c.us');
  }else{
    if (formatted.startsWith('+')) {
      formatted = formatted.replace(/\D/g, '');
    }else{
      formatted = formatted.replace(/\D/g, '');
      if (formatted.startsWith('8')) {
        formatted = '62' + formatted;
      }else if (formatted.startsWith('0')) {
        formatted = '62' + formatted.substr(1);
      }
    }
    if (!formatted.endsWith('@c.us') && !formatted.endsWith('@s.whatsapp.net')) {
      formatted += '@c.us';
    }
    return formatted;
  }
}

exports.WhatsAppHttpApi = WhatsAppHttpApi;
exports.phoneNumberFormatter = phoneNumberFormatter;
