require('dotenv').config({path:__dirname+'/./../.env'});
const argv = process.argv.slice(2);

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
const socketIO = require('socket.io');
const bodyParser = require('body-parser');

const { Op } = require('sequelize')
const { WhatsappService, upsert, Contact, GroupContact, MessageSentLog } = require("./db");
const { useMBSMessage } = require("./mbs_waha");
const { useMBSFeature } = require("./mbs_feature");
const { exec } = require('child_process');
const { Sequelize } = require('sequelize');
const { office } = require("./office");
const { WhatsAppHttpApi, phoneNumberFormatter } = require("./WhatsAppHttpApi");

const isSecure = process.env.APP_SECURE == 1 || process.env.APP_WH_SECURE == 1;
function exit() {
	exec('pm2 delete waha'+argv[0]);
}

(async () => {

const server = (() => {
	if (isSecure) {
		const privateKey = fs.readFileSync( process.env.APP_SECURE == 1 ? process.env.APP_SECURE_KEY : process.env.APP_WH_SECURE_KEY );
		const certificate = fs.readFileSync( process.env.APP_SECURE == 1 ? process.env.APP_SECURE_CERT : process.env.APP_WH_SECURE_CERT );
	
		return https.createServer({
			key: privateKey,
			cert: certificate
		}, app);
	}else{
		return http.createServer(app);
	}
})();
const service = (await WhatsappService.findByPk(argv[0]));
const user = await service.getUser();
if (service === null || user === null) return exit();

office.service = service;
serviceSession = (service.session + "").substring(1);
dockerPort = "3" + serviceSession;
nodejsPort = "4" + serviceSession;

const whatsapp = await (async () => {
	let attempt = 0;
	while (attempt < 3) {
		console.log(service.waha_session);
		const isNewDocker = !Boolean(service.waha_session);
		if (isNewDocker) {
			const {workerId} = await WhatsAppHttpApi.dockerCreate(service.id, dockerPort);
			if (workerId) {
				service.waha_session = workerId;
				await service.save();
				await (new Promise((resolve) => setTimeout(resolve, 10_000)));
				break;
			}
		}
		attempt++;
	}
	if (!Boolean(service.waha_session)) {
		exit();
	}
	attempt = 0;
	while (attempt < 3) {
		console.log(service.waha_session);
		const whatsapp = new WhatsAppHttpApi(
			service.waha_session,
			`${process.env.APP_WH_DOCKER_HOST}`
		);
		process.env.APP_WH_SESSION_NAME && (whatsapp.session.name = process.env.APP_WH_SESSION_NAME);
		
		try {
			let isOff = true;
			do {
				const { status } = (await whatsapp.apiSession().get()).data;
				console.log(status);
				whatsapp.session.status = status;
				isOff = status == whatsapp.SESSION_STATUS.STOPPED || status == whatsapp.SESSION_STATUS.FAILED;
				if (status == whatsapp.SESSION_STATUS.STOPPED || status == whatsapp.SESSION_STATUS.FAILED) {
					await whatsapp.apiSession().restart();
				}
				if (status == whatsapp.SESSION_STATUS.WORKING) {
					const { data } = await whatsapp.apiSession().me();
					whatsapp.user = data;
					whatsapp.name = data.pushName;
					setTimeout(recordGoupAndContact, 6_000);
					socketEmit('user', whatsapp.user);
					mbsMessage.freshDatabaseQueue();
				}
			} while(isOff)
			return whatsapp;
		} catch (err) {
			console.log(`${err}`);
			const dockerResult = await whatsapp.dockerStart();
			await (new Promise((resolve) => setTimeout(resolve, 10_000)));
			if (dockerResult.error) {
				await whatsapp.dockerDelete();
				service.waha_session = null;
				await service.save();
			}
			attempt++;
		}
	}
	console.log("Can't create docker");
	exit();
})()

const mbsMessage = useMBSMessage(whatsapp, service, user)
const { featureHandlers, awayTracks } = useMBSFeature(whatsapp, service, user)

process.on('message', function(packet) {
	if (packet.type == "process:message") {
		const { action } = packet.data
		if (action == "reset") {
			process.stdout.write("event pm2: " + action)
			mbsMessage.freshDatabaseQueue();
		}
	}
});
mbsMessage.startWatch();

async function restartWhatsapp() {
	await (new Promise((resolve) => setTimeout(resolve, 10_000)));
	if (whatsapp.stating == 'offline') await whatsapp.apiSession().restart();
}

whatsapp.ev.on('session.status', async ({ status }) => {
	console.log({ event: 'session.status', status });
	if (status == whatsapp.SESSION_STATUS.STOPPED || status == whatsapp.SESSION_STATUS.FAILED) {
		try {
			const authPhone = await whatsapp.apiSession().get();
			if (!Boolean(authPhone)) {
				service.phone_auth = null;
				service.save({fields: ["phone_auth"]})
				if (sockets.guest.length <= 0){
					setAutoClose();
				}
			}
		} catch (err) {}
		restartWhatsapp();
	}else if (status == whatsapp.SESSION_STATUS.SCAN_QR_CODE) {
		service.phone_auth = null;
		service.save({fields: ["phone_auth"]});
		if (timerClose == null && sockets.guest.length <= 0) {
			setAutoClose();
		}
		socketEmit('qr', whatsapp.qr);
	}else if (status == whatsapp.SESSION_STATUS.WORKING) {
		removeAutoClose();
		service.phone_auth = whatsapp.jid.normalizePnFormat(whatsapp.user.jid);
		service.latest_phone_auth = service.phone_auth;
		service.save({fields: ["phone_auth", "latest_phone_auth"]})
		socketEmit('user', whatsapp.user);
		mbsMessage.freshDatabaseQueue();
		// Update Contact db and GorupContact db
		setTimeout(recordGoupAndContact, 6_000);
	}
})

awayTracks();

whatsapp.ev.on('message.any', async (data) => {
	console.log({ event: 'message.any'})
	featureHandlers(data);
});
whatsapp.ev.on('group.v2.join', async ({group}) => {
	upsert(GroupContact, {name: group.subject, number: group.id, whatsapp_auth: service.phone_auth}, {whatsapp_auth: service.phone_auth, number: group.id})
});
whatsapp.ev.on('group.v2.leave', async ({group}) => {
	GroupContact.destroy({where: { whatsapp_auth: myAuthPhone, number: group.id }});
});

function recordGoupAndContact () {
	const myAuthPhone = service.phone_auth;
	whatsapp.apiContact().all().then(async ({data: result}) => {
		// [ {id: '623718@c.us', name: 'Foo' pushname: '' } ]
		const available = [];
		for(let i in result) {
			const number = await whatsapp.jid.whenLidToPn(result[i].id);
			if (number) {
				available.push(number);
				await upsert(Contact, {name: result[i].name, number: number, whatsapp_auth: myAuthPhone}, {whatsapp_auth: myAuthPhone, number: number})
			}
		}
		await Contact.destroy({
			where: {
				whatsapp_auth: myAuthPhone,
				number: {
					[Op.notIn]: available
				}
			}
		});
	})
	.finally(() => {
		whatsapp.apiGroup().all().then(async ({data: result}) => {
			// [ {JID: '120363422212602390@g.us', Name: 'Foo', ... } ]
			const available = [];
			for(let i in result) {
				available.push(result[i].JID);
				await upsert(GroupContact, {name: result[i].Name, number: result[i].JID, whatsapp_auth: myAuthPhone}, {whatsapp_auth: myAuthPhone, number: result[i].JID})
			}
			await GroupContact.destroy({
				where: {
					whatsapp_auth: myAuthPhone,
					number: {
						[Op.notIn]: available
					}
				}
			});
		});
	});
}

//#region PreServer
const io = socketIO(server, {
	cors: {
		origin: '*',
		methos: ["GET", "POST"]
	}
});
let sockets = { guest: [] };
const systemJwt = process.env.SYSTEM_JWT || null;
const hostUrl = process.env.HOST;
const mediaUrlPrefix = 'media';

app.use('/'+mediaUrlPrefix, express.static('public'))
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json({
	limit: '200mb'
}))
app.use(bodyParser.raw())
app.use(bodyParser.text())
app.use(fileUpload());

app.use(cors({
    methods: "*",
    preflightContinue: false,
}));

app.use((req, res, next) => {
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
//#endregion

app.post("/api/reload/jwt", async (req, res) => {
	try {
		await service.reload();
		if (req.body.jwt_token) {
			service.jwt_token = req.body.jwt_token;
		}
		res.status(200).json({ message: "Jwt Reloaded", code: 100 });
	}catch(e) {
		res.status(400).json({ message: "Service problem", code: 500 });
	}
});

app.post("/api/service/reload", async (req, res) => {
	try {
		await service.reload();
		res.status(200).json({ message: "Service Reloaded", code: 100 });
	}catch(e) {
		res.status(400).json({ message: "Service problem", code: 500 });
	}
});

app.post("/api/group/all", async (req, res) => {
	try {
		if (whatsapp.stating !== 'online') {
			res.status(400).json({ message: "Whatsapp is offline", code: 400 });
		}else{
			whatsapp.apiGroup().all()
			.then((groups) => {
				let ids = groups.map(({JID, Name}) => ({id: JID, subject: Name}));
				res.status(200).json({ message: "Group list", code: 100, data: ids });
			})
			.catch(err => {
				res.status(400).json({ message: "Service problem", code: 500 });
			})
		}
	}catch(e) {
		res.status(400).json({ message: "Service problem", code: 500 });
	}
});
let contactSyncDelay = 0;
app.post("/api/contact/sync", async (req, res) => {
	res.status(200).send("Ok");
	const _date = Date.now();
	try {
		if (whatsapp.stating === 'online' && (_date - contactSyncDelay) > 10_000) {
			contactSyncDelay = _date;
			// [ {id: '623718@c.us', name: 'Foo' pushname: '' } ]
			const availables = new Set(req.body);
			whatsapp.apiContact().all()
			.then(async ({data: result}) => {
				for(let i in result) {
					const number = await whatsapp.jid.whenLidToPn(result[i].id);
					if (number && !availables.has(number)) {
						Contact.create({name: result[i].name, number: number, whatsapp_auth: service.phone_auth})
					}
				}
			})
		}
	}catch(e) {}
});
let groupSyncDelay = 0;
app.post("/api/group/sync", async (req, res) => {
	res.status(200).send("Ok");
	const _date = Date.now();
	try {
		if (whatsapp.stating === 'online' && (_date - groupSyncDelay) > 10_000) {
			groupSyncDelay = _date;
			whatsapp.apiGroup().all()
			.then(async ({data: result}) => {
				for(let i in result) {
					if (!req.body[result[i].JID]) {
						GroupContact.create({name: result[i].Name, number: result[i].JID, whatsapp_auth: service.phone_auth})
					}
				}
			})
		}
	}catch(e) {}
});

app.post("/api/reciever/reload", async (req, res) => {
	res.status(200).json({ message: "Reciever triggered reload", code: 100 });
})

app.post("/api/phone/check", async (req, res) => {
	try {
		if (whatsapp.stating !== 'online') {
			res.status(400).json({ message: "Whatsapp is offline", code: 400 });
		}else{
			let number = req.body.number || req.query.number;
			number = phoneNumberFormatter(number);
			const result = await whatsapp.apiContact().exists(number);
			if (result && result.numberExists) {
				res.status(200).json({ message: "Number is exists", code: 100, result: { number, exists: true } });
			} else {
				res.status(200).json({ message: "Number is not exists", code: 200, result: { number, exists: false } });
			}
		}
	} catch (e) {
		console.log(e);
		res.status(409).json({ message: "Service problem", code: 500 });
	}
});

app.post("/api/cs/notify", async (req, res) => {
	try {
		const id = req.body.id
		console.log(req.body.notif)
		if (!id) {
			res.status(400).json({ message: "Message id is invalid", code: 200 });
		}else{
			const messageSentLog = await MessageSentLog.findByPk(id);
			if (messageSentLog.sender_by && ((req.body.notif == 'start' && (messageSentLog.processed_messages > 20 || messageSentLog.schedule != null)) || req.body.notif == 'end')) {
				let sender = await messageSentLog.getSender();
				const notyfTo = [];
				const wa_service = await messageSentLog.getWhatsappService();
				if (sender) {
					if (sender.role_id == 3) {
						const admin = await wa_service.getUser();
						if (admin.phone) {
							const number = phoneNumberFormatter(admin.phone);
							(await whatsapp.checkDestination(number)) && notyfTo.push(number);
						}
					}
					if (sender.phone) {
						const number = phoneNumberFormatter(sender.phone);
						(await whatsapp.checkDestination(number)) && notyfTo.push(number);
					}
					// const monitoring = process.env.MONITORING.split(',');
					// if (monitoring.length > 0) {
					// 	for(let i in monitoring) {
					// 		const number = phoneNumberFormatter(monitoring[i]);
					// 		(await whatsapp.checkDestination(number)) ? notyfTo.push(number) : null;
					// 	}
					// }
					if (notyfTo.length > 0) {
						let fileData = null, content = null;
						const messageMediaSentLog = await messageSentLog.getMessageMediaSentLog(),
							has_generated = messageSentLog.generated_content && typeof messageSentLog.generated_content === 'object' && !Array.isArray(messageSentLog.generated_content),
							contentKeys = has_generated ? Object.keys(messageSentLog.generated_content) : [];
			
						if (messageMediaSentLog) {
							if (!fileData) {
								fileData = await (async (url, options) => {
									try {
										options ? options : {timeout : 10}
										const res = await axios({
											method: "get",
											url,
											...options,
											responseType: 'arraybuffer'
										})
										return res.data
									} catch (e) {
										console.log(`Error : ${e}`)
										return undefined
									}
								})(messageMediaSentLog.url);
							}
							const file = {
								name: messageMediaSentLog.name,
								data: fileData,
								mimetype: mime.lookup(messageMediaSentLog.name)
							};
							content = {text: messageSentLog.message, type: 'media', file: file, ...(contentKeys.length > 0 ? {contex: messageSentLog.generated_content} : {})}
						}else{
							content = {text: messageSentLog.message, type: 'text', ...(contentKeys.length > 0 ? {contex: messageSentLog.generated_content} : {})}
						}

						let notyfMessage = '';
						if (req.body.notif == 'start') {
							notyfMessage = `*MBS Messaging*\n*(Do Not Reply)*\n\r\n*${sender.name}* telah mengirimkan pesan ${messageSentLog.message ? 'diatas ' : ''}ke *${messageSentLog.processed_messages}* nomor whatsapp melalui nomor *${wa_service.name} (${wa_service.latest_phone_auth.split(':')[0]})* pada ${moment(messageSentLog.schedule || undefined).format("D MMMM YYYY HH:mm")}`;
						}else{
							const conclusion = await messageSentLog.getMessageNumberSentLogs({
								attributes: [
									[Sequelize.fn('COUNT', Sequelize.fn('IF', Sequelize.literal("`status` = 'success'"), 1, null) ), "success"],
									[Sequelize.fn('COUNT', Sequelize.fn('IF', Sequelize.literal("`status` != 'success'"), 1, null) ), "failed"]
								]
							});
							notyfMessage = `*MBS Messaging*\n*(Do Not Reply)*\n\r\n*${sender.name}* telah mengirimkan pesan diatas ke *${messageSentLog.processed_messages}* nomor whatsapp melalui nomor *${wa_service.name} (${wa_service.latest_phone_auth.split(':')[0]})* pada ${(moment(messageSentLog.schedule || req.body.now || undefined)).format('D MMMM YYYY HH:mm')}\n\r\nProses pengiriman telah selesai pada ${moment().format('D MMMM YYYY HH:mm')}\n\r\nBerhasil: ${conclusion[0].dataValues.success || 0} nomor\nGagal : ${conclusion[0].dataValues.failed || 0} nomor`;
						}

						for(let i in notyfTo) {
							await whatsapp.sendMessage(notyfTo[i], {...content, mentions : []});
							await whatsapp.sendMessage(notyfTo[i], {text: notyfMessage, mentions : []}, 'text');
						}
					}
				}
			}
			res.status(200).json({ message: "Pesan Terkirim", code: 100 });
		}
	}catch(e){
		console.log(e)
		res.status(500).json({ message: "Service problem", code: 500 });
	}
	res.status(400).json({ message: "API Url Closed", code: 999 });
})

app.post("/api/whatsapp/send", async (req, res) => {
	try {
		const idd = req.body.id
		console.log(req.body.id)
		if (!idd) {
			res.status(400).json({ message: "Message id is invalid", code: 200 });
		}else{
			await service.reload();
			const [id, with_message_id] = idd.split(";");
			const messageSentLog = await service.getMessageSentLog({ where : { id } });
			console.log(messageSentLog.schedule);
			if (with_message_id) {
				console.log("2Pesan", {id, with_message_id})
				await mbsMessage.insertQueue({id, with_message_id}, messageSentLog.schedule || undefined, false)
			}else{
				console.log("1Pesan", id)
				await mbsMessage.insertQueue(id, messageSentLog.schedule || undefined, messageSentLog.event === 'send_message')
			}
			res.status(200).json({ message: "Insert Message Successfully", code: 100 });
		}
	}catch(e) {
		console.log(e)
		res.status(500).json({ message: JSON.stringify(e), code: 500 });
	}
});

app.post("/api/whatsapp/remove", async (req, res) => {
	try {
		const id = req.body.id
		if (!id) {
			res.status(400).json({ message: "Message id is invalid", code: 200 });
		}else{
			if (mbsMessage.remove(id)) {
				res.status(200).json({ message: "Removed Successfully", code: 100 });
			}else{
				res.status(200).json({ message: "Checked ID isn't in queue", code: 101 });
			}
		}
	}catch(e) {
		console.log(e);
		res.status(500).json({ message: "Service problem", code: 500 });
	}
});

app.post("/api/whatsapp/close", async (req, res) => {
	res.sendStatus(200);
	try {
		await whatsapp.apiSession().logout();
		await whatsapp.dockerStop();
		await whatsapp.dockerDelete();
		service.waha_session = null;
		service.save();
	} catch (err) {}
	exit();
});

app.post("/api/whatsapp/silent", async (req, res) => {
	res.sendStatus(200);
	await whatsapp.dockerStop();
	exit();
});

app.post("/api/whatsapp/check", async (req, res) => {
	await service.reload();
	res.json({status: Boolean(whatsapp.user.id)}).sendStatus(200);
});

function validationNumberAndType(req) {
	let number = req.body.to || req.query.to,
		type = req.body.type || req.query.type || 'text';

	if (!number) {
		throw { message: "Whatsapp number is required", code: 1 }
	}else{
		number = phoneNumberFormatter(number);
	}
	if (!types.includes(type)) {
		throw { message: "Type is not available", code: 9 };
	}
	if (type && mediaTypes.includes(type) && !((req.files && (req.files.file || req.files.image)) || req.body.file)) {
		throw { message: "Media file not found", code: 2 };
	}
	if ((type === 'message' || type === 'text') && !(req.body.text || req.query.text)) {
		throw { message: "Text is required", code: 10 };
	}
	return {number, type}
}

function validateContentFormRequest(req, type = "") {
	const content = whatsapp.createContent();
	if (type === 'location') {
		const rawContent = {
			title: req.body.name || req.query.name,
			latitude: req.body.degreesLatitude || req.query.degreesLatitude,
			longitude: req.body.degreesLongitude || req.query.degreesLongitude
		}
		for(let i in rawContent) {
			if ((i === "latitude" || i === "longitude") && typeof rawContent[i] === "string") {
				rawContent[i] = parseFloat(rawContent[i])
			}
		}
		content.location(
			rawContent.title,
			rawContent.latitude,
			rawContent.longitude,
		)
		try {
			content.locationValidation();
		}catch(e) {
			if (isErrorString = typeof e === 'string') {
				throw { message: e, code: 12 }
			}
			throw e
		}
	}else if (type === 'contact' || type === 'contacts') {
		if (req.is('application/json')) {
			if (!req.body.contacts) {
				throw { message: "contacts is required", code: 12 };
			}
			if (!Array.isArray(req.body.contacts)) {
				throw { message: "contacts must array", code: 12 };
			}
			const rawContent = req.body.contacts;
			content.contacts(...rawContent);
		}else{
			let address_home = req.body.address_home || req.query.address_home;
			if (address_home && !Array.isArray(address_home)) address_home = [address_home];
			let address_work = req.body.address_work || req.query.address_work
			if (address_work && !Array.isArray(address_work)) address_work = [address_work];
			const rawContent = {
				fullname: req.body.fullname || req.query.fullname,
				nickname: req.body.nickname || req.query.nickname,
				organization: req.body.organization || req.query.organization,
				birth_day: req.body.birth_day || req.query.birth_day,
				url: req.body.url || req.query.url,
				email: req.body.email || req.query.email,
				whatsapp: req.body.whatsapp || req.query.whatsapp,
				telephone: req.body.telephone || req.query.telephone,
				...(address_home ? {address_home} : {}),
				...(address_work ? {address_work} : {})
			}
			for(let i in rawContent) {
				if (rawContent[i] === undefined) delete rawContent[i];
			}
			content.contacts(rawContent);
		}
		try {
			content.contactValidation();
		}catch(e) {
			if (isErrorString = typeof e === 'string') {
				throw { message: e, code: 13 }
			}
			throw e;
		}
	}
	return content;
}

app.post("/api/content/generate", async (req, res) => {
	const contentBuilder = validateContentFormRequest(req, req.body.type);
	generatedContent = contentBuilder.getContent();
	if (generatedContent) {
		res.status(200).json({ data: generatedContent, message: 'Generated and validated successfully' });
	}
});

const types = ['message', 'text', 'media', 'file', 'location', 'contact', 'contacts']
const mediaTypes = ['media', 'file']
app.post("/api/message/send", async (req, res) => {
	let number, type, contentBuilder;
	try {
		const result = validationNumberAndType(req);
		number = result.number;
		type = result.type;
	} catch (err) {
		if (typeof err === "object") {
			res.status(400).send(err);
		}else{
			res.status(400).send({ message: "Fail number and type validation", code: 500 });
		}
		return;
	}

	try {
		contentBuilder = validateContentFormRequest(req, type);
	} catch (err) {
		if (typeof err === "object") {
			res.status(400).send(err);
		}else{
			res.status(400).send({ message: "Fail generated content and validation", code: 500 });
		}
		return;
	}

	let dataFile = null;
	if (req.body.file) {
		dataFile = {...req.body.file};
		try {
			if (!dataFile.name) throw "File name is required";
			if (typeof dataFile.name !== "string") throw "File name must string";
			if (!dataFile.data) throw "File data is required";
			if (typeof dataFile.data !== "string") throw "File data must string";
			if (!dataFile.mimetype) throw "File mimetype is required";
			if (typeof dataFile.mimetype !== "string") throw "File mimetype must string";
		}catch(e) {
			if (typeof e === "string") {
				res.status(429).json({ message: "File must base64", code: 14 });
				return;
			}
		}
		dataFile.data = Buffer.from(dataFile.data, 'base64');
		if (!dataFile.data) {
			res.status(429).json({ message: "File must base64", code: 14 });
			return;
		}
	}

	const messageSentLog = await service.createMessageSentLog({
		message: req.body.text || req.query.text || '',
		event: 'api_send_message',
		raw_content: null,
		generated_content: contentBuilder.getContent(),
		processed_messages: 1,
	});

	await service.reload();
	await user.reload();
	const cost_credits = user.is_subscription_service ? 0 : service.cost_per_message
	async function insertNumber(status = null, response = null) {
		await messageSentLog.createMessageNumberSentLog({
			number: number,
			entity: [number],
			host: req.socket.remoteAddress,
			status: status,
			response: response,
			cost_credits: (status === 'success' || !status) ? cost_credits : 0
		});
		if (status) {
			messageSentLog.status = 'complete';
			await messageSentLog.save({fields:["status"]});
		}
	}

	try {
		let file;
		if (req.files != null || dataFile) {
			if (dataFile) {
				file = {...dataFile}
			}else if (req.files.file !== undefined) {
				file = req.files.file;
			} else if (req.files.image !== undefined) {
				file = req.files.image;
			}
			if (file) {
				const now = new Date();
				const tomonthPath = [now.getFullYear(), now.getMonth() + 1].join("-");
				if (!fs.existsSync("./public")) {
					fs.mkdirSync("./public")
				}
				if (!fs.existsSync("./public/"+tomonthPath)) {
					fs.mkdirSync("./public/"+tomonthPath)
				}
				const filename = [service.id, messageSentLog.id, now.getTime(), file.name].join("-");
				const filepath = tomonthPath+"/"+filename;
				const extension = mime.extension(file.mimetype) || '';

				fs.writeFileSync("./public/"+filepath, file.data);

				await messageSentLog.createMessageMediaSentLog({
					name: filename,
					extension: extension,
					url: hostUrl+':'+nodejsPort+'/'+mediaUrlPrefix+'/'+filepath
				});
			}
		}

		if (user.is_subscription_service) {
			const message = "Pesan Diproses";
			await insertNumber();
			const result = await mbsMessage.insertQueue(messageSentLog.id+"", messageSentLog.schedule || undefined, false)
			res.status(200).json({ message: message });
		}else{
			if ((user.credits - cost_credits) < 0.00) {
				const message = "Kredit tidak mencukupi";
				await insertNumber("abort", message);
				res.status(402).json({ message: message, code: 5 });
				return;
			}else{
				const message = "Pesan Diproses";
				const credit_before_changes = user.credits,
					amount_change_in_credits = cost_credits,
					latest_credit = credit_before_changes - amount_change_in_credits;
				user.credits -= cost_credits;
				await user.save({fields:["credits"]});
				await messageSentLog.createCreditHistory({
					user_id: user.id,
					event: 'api_send_message',
					credit_before_changes,
					amount_change_in_credits,
					latest_credit
				});
				await insertNumber();
				const result = await mbsMessage.insertQueue(messageSentLog.id+"", messageSentLog.schedule || undefined, false)
				res.status(200).json({ message: message });
			}
		}

	} catch (e) {
		console.log(e)
		const message = "Service Tidak Berjalan / Hubungi Admin";
		await insertNumber("abort", message);
		res.status(500).json({ message: message, code: 8 });
	}
});

//#region Socket
let timerClose = null;
function setAutoClose(mm = 30000) {
	timerClose = setTimeout(async () => {
		if (sockets.guest.length <= 0) {
			whatsapp.dockerStop();
			exit();
		}
	}, mm);
}
function removeAutoClose() {
	clearTimeout(timerClose);
	timerClose = null;
}

function socketEmit(name, data, socket = null) {
	if (socket) {
		socket.emit(name, {stating: whatsapp.stating, data})
	}else{
		sockets.guest.every(client => 
			client.socket.emit(name, {stating: whatsapp.stating, data})
		);
	}
}

io.on("connection", function (socket) {
	let id = socket.handshake.auth.token;

	const clientId = Date.now();
	sockets.guest.push({id, clientId, socket})
	console.log("connected: ", clientId, id, '('+sockets.guest.length+')', whatsapp.stating, whatsapp.user);

	if (whatsapp.stating == 'qr' && !whatsapp.qr) {
		whatsapp.apiSession().qr()
		.then(({ data }) => {
			whatsapp.qr = data.toString("base64");
			socketEmit('qr', whatsapp.qr);
		});
	}else if (whatsapp.qr) socketEmit('qr', whatsapp.qr);

	if (whatsapp.stating == 'online') {
		socketEmit('user', whatsapp.user);
	}

	socket.on('disconnect', (reason) => {
		sockets.guest = sockets.guest.filter(client => client.clientId !== clientId);
		console.log("disconnected: ", clientId, id, '('+(sockets.guest.length)+')');

		if (sockets.guest.length <= 0 && whatsapp.stating !== 'online') {
			setAutoClose()
		}
	})
});


mbsMessage.startWatch();
server.listen(nodejsPort, async () => {
	console.log('listening on ' + server.address().port);
	whatsapp.listenEvents();
});

})();
//#endregion

