const { MessageNumberSentLog, ForwardReceiver, OutForwardReceiver, MessageSentLog, GroupContact, Contact } = require("./db");
const mime = require("mime-types");
const fs = require('fs');
const axios = require('axios');
const { sequelize } = require("./db");
const { useSqlTrack } = require("./activity");
const moment = require('moment');

const hostUrl = 'https://api.whatsapp.maestrobyte.com';

function useMBSFeature (whatsapp, service, user) {
  const activity = useSqlTrack('wa'+service.id);

  function cloneWithoutHiddenData (message) {
    let cloneMessage = JSON.parse(JSON.stringify(message));
    if (cloneMessage._replyTo?._data) delete cloneMessage._replyTo._data;
    delete cloneMessage._data;
    return cloneMessage;
  }

  function getChatId(message) {
    return message.id.split("_")[2];
  }

  async function payWithCredit(messageSentLog, event, multiply = 1) {
    const credit_before_changes = user.credits,
      amount_change_in_credits = (service.cost_per_forward * multiply),
      latest_credit = credit_before_changes - amount_change_in_credits;
        
    if (!user.is_subscription_service && credit_before_changes >= amount_change_in_credits) {
      user.credits -= amount_change_in_credits;
      await user.save({fields:["credits"]});

      await messageSentLog.createCreditHistory({
        user_id: user.id,
        event,
        credit_before_changes,
        amount_change_in_credits,
        latest_credit
      });

      return true;
    }
    return false;
  }

  function awayTracks() {
    const now = moment();
    setInterval(() => {
      now.add(1, 'minute');
      if (!service.feature_chat_bot_google || !service.is_chat_away_message) return;
      sequelize.query(
        "SELECT `chatbot_sheets`.`id`, `chatbot_sheets`.`reply`, `chatbot_sheets`.`interval` FROM `chatbot_sheets` " +
        "WHERE `chatbot_sheets`.`whatsapp_service_id` = "+service.id+" " +
        "AND `chatbot_sheets`.`type` = 'away' " +
        "LIMIT 1",
        { type: "SELECT" }
      ).then(async ([ botReply ]) => {
        if (!botReply) return;
        const rows = await activity.getAwayNumbers(botReply.interval, now).catch(() => {});
        if (rows && Array.isArray(rows)) {
          for (const row of rows) {
            const remoteJid = row.id;
            const text_reply = botReply.reply;
            const send_event = 'chat_bot_away_reply';
            setTimeout(async () => {
              const messageSentLog = await service.createMessageSentLog({
                message : text_reply,
                event: send_event,
                processed_messages: 1,
                phone_auth: service.phone_auth,
                status: 'complete'
              }).catch(err => null);
  
              const insertNumberSentLog = (status, message, payload = null) => {
                messageSentLog.createMessageNumberSentLog({
                  number: remoteJid,
                  entity: [remoteJid],
                  status: status,
                  response: message,
                  id_stanza: payload ? payload.id_stanza : null,
                  send_json: payload ? payload.send_json : null,
                  cost_credits: status == 'success' ? user.is_subscription_service ? 0 : service.cost_per_forward : 0
                });
              }
  
              if (user.is_subscription_service || payWithCredit(messageSentLog, send_event)) {
                whatsapp.sendMessage(remoteJid, {text: text_reply})
                .then(({data}) => {
                  data = cloneWithoutHiddenData(data);
                  insertNumberSentLog('success', 'Pesan Terkirim', {
                    send_json: data,
                    id_stanza: getChatId(data)
                  })
                }).catch(err => {
                  insertNumberSentLog('success', 'Pesan Terkirim')
                  console.log(err)
                })
              }else{
                insertNumberSentLog('abort', 'Kredit tidak mencukupi')
              }
            }, (moment(row.latest).unix() - now.unix()) * 1000)
          }
        }
      }).catch(e => {console.log(e)})
    }, 60_000)
  }

  async function featureHandlers(msg) {
    // message incoming at pass of before current timestamp is possible;
    if (!service.phone_auth) return;
    if (!Boolean(msg.body || msg.hasMedia || msg.location || msg.vCards || msg.replyTo)) return;

    if (whatsapp.jid.isJidStatusBroadcast(msg.from)) return;
    const msgFrom = await whatsapp.jid.whenLidToPn(whatsapp.jid.isJidBroadcast(msg.from) ? msg.participant : msg.from);

    if (!msgFrom || !(whatsapp.jid.isJid(msgFrom) || whatsapp.jid.isPnUser(msgFrom) || whatsapp.jid.isJidGroup(msgFrom))) return;

    await service.reload();
    await user.reload();    

    await chatBotFeature(msgFrom, msg);
    if (service.feature_chat_bot_google && service.is_chat_welcome_message && !whatsapp.jid.isJidGroup(msgFrom) && !msg.fromMe) {
      activity.updateChatTime(msgFrom, msg.timestamp);
    }

    await outForwardMessage(msgFrom, msg);
    await forwardMessage(msgFrom, msg);
  }

  async function forwardMessage(remoteJid, msg) {
    if (!service.feature_forward || !service.is_forward || !(service.is_main_forward || service.is_specified_forward)) return;
    if (msg.fromMe) return;

    const self_phone = service.phone_auth;
    const cost_credits = user.is_subscription_service ? 0 : service.cost_per_forward;

    let receivers = [],
      senders = [],
      loadOnceMain = false;

    async function hasReceivers () {
      if (!loadOnceMain) {
        receivers = await service.getForwardReceivers({
          where: {
            forward_sender_id: null
          },
        });
        loadOnceMain = true;
      }
      return receivers.length > 0
    }
    async function anySenderHasReceivers (number) {
      senders = await service.getForwardSenders({
        where: {
          number: number
        },
        include: [{
          model: ForwardReceiver,
          as: 'forwardReceivers'
        }],
      });
  
      senders = senders.filter(sender => sender.forwardReceivers.length > 0)
      return senders.length > 0
    }

    //reply
    const [is_reply, forwardMessageNumberSentLog, forwardSender] = await (async () => {
      if (!Boolean(msg.replyTo)) throw new Error();
      const participant = await whatsapp.jid.whenLidToPn(msg.replyTo.participant);
      if (!participant.startsWith(self_phone.split("@")[0])) throw new Error();
      const forwardMessageNumberSentLog = await MessageNumberSentLog.findOne({where: {
        number: remoteJid,
        id_stanza: msg.replyTo.id
      }, include: [{
        model: MessageSentLog,
        as: 'messageSentLog'
      }]})
      if (!forwardMessageNumberSentLog) throw new Error();
      if (forwardMessageNumberSentLog.messageSentLog.forward_sender_id) {
        const forwardSender = await forwardMessageNumberSentLog.messageSentLog.getForwardSender({
          include: [{
            model: ForwardReceiver,
            as: 'forwardReceivers'
          }]
        })
        const is_reply = Boolean(forwardSender && forwardSender.forwardReceivers.length > 0 && forwardSender.forwardReceivers.find((receiver) => receiver.can_reply && receiver.number == remoteJid))
        return [is_reply, forwardMessageNumberSentLog, forwardSender || null];
      }else{
        await hasReceivers();
        return [Boolean(receivers.find((receiver) => receiver.can_reply && receiver.number == remoteJid)), forwardMessageNumberSentLog, null];
      }
    })()
    .catch(err => [false, null, null]);

    //filter & ignore
    let is_ignored = !is_reply && service.is_main_forward && (await service.getForwardIgnore({ where : { number : remoteJid }})) != null;

    const mainHasReceivers = !is_reply && service.is_main_forward && !is_ignored && await hasReceivers();
    const specifiedHasReceivers = !is_reply && service.is_specified_forward && await anySenderHasReceivers(remoteJid);
    if (!mainHasReceivers && !specifiedHasReceivers && !is_reply) return;

    // content
    const contentBuilder = whatsapp.createContent();
    if (msg.hasMedia) {
      contentBuilder.file(
        msg.media.url,
        msg.media.filename,
        msg.media.mimetype
      )
    }
    if (Boolean(msg.location)) {
      contentBuilder.location(
        msg.location.title || "",
        msg.location.latitude,
        msg.location.longitude,
      )
      for (const key in msg.location) {
        if (key !== 'title' && key !== 'latitude' && key !== 'longitude') {
          contentBuilder._fields.add(key);
          contentBuilder._content[key] = msg.location[key];
        }
      }
    }
    if (Boolean(msg.vCards)) {
      contentBuilder.contacts(...msg.vCards.map((vcard) => { vcard }))
    }

    // forwards
    const jidGroup = whatsapp.jid.isJidGroup(remoteJid);
    if (is_reply) {
      const contact = (forwardMessageNumberSentLog.messageSentLog.forward_sender_id
        ? forwardSender.forwardReceivers.find((receiver) => receiver.number == remoteJid)
        : receivers.find((receiver) => receiver.number == remoteJid))
        || await (jidGroup ? GroupContact : Contact).findOne({ where: { whatsapp_auth: self_phone, number: remoteJid } });

      const template = `Replied by ${jidGroup ? ("Group " + contact.name) : (((contact && contact.name) || "")+" *"+remoteJid+"*") }`;
      const patienceContentBuilder = contentBuilder.clone();

      if (Boolean(msg.body)) {
        patienceContentBuilder.message(msg.body);
        contentBuilder.message(template + '\n\r\n' + msg.body);
      }else if(msg.hasMedia) {
        contentBuilder.message(template);
      }

      let localReceivers = forwardMessageNumberSentLog.messageSentLog.forward_sender_id
        ? forwardSender.forwardReceivers.filter((receiver) => receiver.number != remoteJid)
        : receivers.filter((receiver) => receiver.number != remoteJid);

      const content = contentBuilder.getContent();

      const messageSentLog = await service.createMessageSentLog({
        message: content?.text || null,
        event: 'forward_message',
        generated_content : content || null,
        forward_from : forwardMessageNumberSentLog.number,
        forward_sender_id: forwardMessageNumberSentLog.messageSentLog.forward_sender_id,
        processed_messages: localReceivers.length + 1,
        phone_auth: self_phone,
        status: 'complete'
      }).catch(err => null);

      msg.hasMedia && await messageSentLog.createMessageMediaSentLog({
        name: full_name,
        extension: extension,
        url: hostUrl+':'+service.session+(content.file.url.split("api/files")[1]),
      }).catch(err => null);

      const forwardNumber = forwardMessageNumberSentLog.messageSentLog.forward_from;

      const insertNumberSentLog = (status, number, message) => {
        messageSentLog.createMessageNumberSentLog({
          number: number,
          entity: [number],
          status: status,
          response: message,
          cost_credits: status == 'success' ? cost_credits : 0
        });
      }

      let validReciever = [];
      let invalidReceiver = [];
      let selfReciever = null;
      let abort = false;
      for (let reciever of localReceivers) {
        if (self_phone == reciever.number) {
          selfReciever = reciever.number;
        }else{
          let found = await whatsapp.checkDestination(reciever.number)
          if (found) {
            validReciever.push(reciever.number);
          }else if(found === false){
            invalidReceiver.push(reciever.number);
          }else{
            abort = true;
          }
        }
      }
      if (abort) {
        insertNumberSentLog('abort', forwardNumber, 'Nomor Whatsapp Offline')
        for (let reciever of localReceivers) {
          insertNumberSentLog('abort', reciever.number, 'Nomor Whatsapp Offline')
        }
      }else{
        if (user.is_subscription_service || payWithCredit(messageSentLog, 'forward_message', validReciever.length + 1)) {
          whatsapp.sendMessage(forwardNumber, patienceContentBuilder.getContent()).catch(err => {console.log(err)})
          insertNumberSentLog('success', forwardNumber, 'Pesan Terkirim')

          const quotes = await forwardMessageNumberSentLog.messageSentLog.getMessageNumberSentLogs();
          for(let number of validReciever) {
            content.reply_to = (quotes.find((numberSent) => numberSent.number == number) || {send_json: {id: null}}).send_json.id;
            whatsapp.sendMessage(number, content).catch(err => {console.log(err)})
            insertNumberSentLog('success', number, 'Pesan Terkirim')
          }
          for(let number of invalidReceiver) {
              insertNumberSentLog('failed', number, 'Nomor Tujuan Tidak Valid')
          }
          if (selfReciever) {
            insertNumberSentLog('failed', selfReciever, 'Nomor Tujuan Adalah Diri Sendiri')
          }
        }else{
          insertNumberSentLog('abort', forwardNumber, 'Kredit tidak mencukupi')
          for (let reciever of localReceivers) {
            insertNumberSentLog('abort', reciever.number, 'Kredit tidak mencukupi')
          }
        }
      }
    }else{
      const doForward = async (localReceivers, sender = null) => {
        const contact = sender || await (jidGroup ? GroupContact : Contact).findOne({ where: {
          whatsapp_auth: self_phone,
          number: remoteJid
        } })
        const template = `_Received Message on_\n${service.name ? '*'+service.name+' ' : '*'}(${service.phone_auth.split(":")[0]})*\n_Message From${ (jidGroup ? " Group": "") }_\n${ contact && contact.name ? "*"+contact.name+"*" : "" }${jidGroup ? "" : " "+(remoteJid.split("@")[0])}`;

        if (Boolean(msg.body)) {
          contentBuilder.message(template + '\n\r\n' + msg.body);
        }else if(msg.hasMedia) {
          contentBuilder.message(template);
        }

        const content = contentBuilder.getContent();

        const messageSentLog = await service.createMessageSentLog({
          message: content?.text || null,
          event: 'forward_message',
          generated_content : content || null,
          forward_from : remoteJid,
          id_forward_from : msg.id,
          source_json: is_reply ? null : cloneWithoutHiddenData(msg),
          forward_sender_id: sender ? sender.id : null,
          processed_messages: localReceivers.length,
          phone_auth: self_phone,
          status: 'complete'
        }).catch(err => null);
            
        msg.hasMedia && await messageSentLog.createMessageMediaSentLog({
          name: full_name,
          extension: extension,
          url: hostUrl+':'+service.session+(content.file.url.split("api/files")[1]),
        }).catch(err => null);
            
        const insertNumberSentLog = (status, number, message, payload = null) => {
          messageSentLog.createMessageNumberSentLog({
            number: number,
            entity: [number],
            status: status,
            response: message,
            id_stanza: payload ? payload.id_stanza : null,
            send_json: payload ? payload.send_json : null,
            cost_credits: status == 'success' ? cost_credits : 0
          });
        }
        let validReciever = [];
        let invalidReceiver = [];
        let selfReciever = null;
        let abort = false;
        for (let reciever of localReceivers) {
          if (self_phone == reciever.number) {
            selfReciever = reciever.number;
          }else{
            let found = await whatsapp.checkDestination(reciever.number)
            if (found) {
              validReciever.push(reciever.number);
            }else if(found === false){
              invalidReceiver.push(reciever.number);
            }else{
              abort  = true;
            }
          }
        }
        if (abort) {
          for (let reciever of localReceivers) {
            insertNumberSentLog('abort', reciever.number, 'Nomor Whatsapp Offline')
          }
        }else{
          if (user.is_subscription_service || payWithCredit(messageSentLog, 'forward_message', validReciever.length)) {
            for(let number of validReciever) {
              whatsapp.sendMessage(number, content)
              .then(({data}) => {
                data = cloneWithoutHiddenData(data);
                insertNumberSentLog('success', number, 'Pesan Terkirim', {
                  send_json: data,
                  id_stanza: getChatId(data)
                })
              }).catch(err => {
                insertNumberSentLog('success', number, 'Pesan Terkirim')
                console.log(err)
              })
            }
            for(let number of invalidReceiver) {
              insertNumberSentLog('failed', number, 'Nomor Tujuan Tidak Valid')
            }
            if (selfReciever) {
              insertNumberSentLog('failed', selfReciever, 'Nomor Tujuan Adalah Diri Sendiri')
            }
          }else{
            for (let reciever of localReceivers) {
              insertNumberSentLog('abort', reciever.number, 'Kredit tidak mencukupi')
            }
          }
        }
      }
      
      if (mainHasReceivers) {
        await doForward(receivers)
      }
      if (specifiedHasReceivers) {
        for(let j in senders) {
          await doForward(senders[j].forwardReceivers, senders[j])
        }
      }
    }
  }

  async function outForwardMessage(remoteJid, msg) {
    if (!service.feature_out_forward || !service.is_out_forward || !(service.is_out_main_forward || service.is_out_specified_forward)) return;
    if (!msg.fromMe) return;

    const self_phone = service.phone_auth;
    const cost_credits = user.is_subscription_service ? 0 : service.cost_per_forward;

    let out_receivers = [],
      out_senders = [],
      out_loadOnceMain = false;

    async function out_hasReceivers () {
      if (!out_loadOnceMain) {
        out_receivers = await service.getOutForwardReceivers({
          where: {
            out_forward_sender_id: null
          },
        });
        out_loadOnceMain = true;
      }
      return out_receivers.length > 0
    }
    async function out_anySenderHasReceivers (number) {
      out_senders = await service.getOutForwardSenders({
        where: {
            number: number
        },
        include: [{
          model: OutForwardReceiver,
          as: 'outForwardReceivers'
        }],
      });
  
      out_senders = out_senders.filter(sender => sender.outForwardReceivers.length > 0)
      return out_senders.length > 0
    }

    const is_ignored = service.is_out_main_forward && (await service.getOutForwardIgnore({ where : { number : remoteJid }})) != null;

    const mainHasReceivers = service.is_out_main_forward && !is_ignored && await out_hasReceivers();
    const specifiedHasReceivers = service.is_out_specified_forward && await out_anySenderHasReceivers(remoteJid);
    if (!mainHasReceivers && !specifiedHasReceivers) return;

    // content
    const contentBuilder = whatsapp.createContent();
    if (msg.hasMedia) {
      contentBuilder.file(
        msg.media.url,
        msg.media.filename,
        msg.media.mimetype
      )
    }
    if (Boolean(msg.location)) {
      contentBuilder.location(
        msg.location.title || "",
        msg.location.latitude,
        msg.location.longitude,
      )
      for (const key in msg.location) {
        if (key !== 'title' && key !== 'latitude' && key !== 'longitude') {
          contentBuilder._fields.add(key);
          contentBuilder._content[key] = msg.location[key];
        }
      }
    }
    if (Boolean(msg.vCards)) {
      contentBuilder.contacts(...msg.vCards.map((vcard) => { vcard }))
    }
    
    // forwards
    const isGroup = whatsapp.jid.isJidGroup(remoteJid);

    const doForward = async (localReceivers, sender = null) => {
      let contact = sender || await (isGroup ? GroupContact : Contact).findOne({ where: {
        whatsapp_auth: self_phone,
        number: remoteJid
      } })
      const template = `_Sent Message from_\n${service.name ? '*'+service.name+' ' : '*'}(${service.phone_auth.split(":")[0]})*\n_Message To${ (isGroup ? " Group": "") }_\n${ contact && contact.name ? "*"+contact.name+"*" : "" }${isGroup ? "" : " "+(remoteJid.split("@")[0])}`;
      if (Boolean(msg.body)) {
        contentBuilder.message(template + '\n\r\n' + msg.body)
      }else if(msg.hasMedia) {
        contentBuilder.message(template);
      }
      const content = contentBuilder.getContent();

      const messageSentLog = await service.createMessageSentLog({
        message: content?.text || null,
        event: 'out_forward_message',
        generated_content : content || null,
        forward_from : remoteJid,
        id_forward_from : msg.id,
        source_json: cloneWithoutHiddenData(msg),
        out_forward_sender_id: sender ? sender.id : null,
        processed_messages: localReceivers.length,
        phone_auth: self_phone,
        status: 'complete'
      }).catch(err => null);

      msg.hasMedia && await messageSentLog.createMessageMediaSentLog({
        name: full_name,
        extension: extension,
        url: hostUrl+':'+service.session+(content.file.url.split("api/files")[1]),
      }).catch(err => null);

      const insertNumberSentLog = (status, number, message, payload = null) => {
        messageSentLog.createMessageNumberSentLog({
          number: number,
          entity: [number],
          status: status,
          response: message,
          id_stanza: payload ? payload.id_stanza : null,
          send_json: payload ? payload.send_json : null,
          cost_credits: status == 'success' ? cost_credits : 0
        });
      }
      let validReciever = [];
      let invalidReceiver = [];
      let selfReciever = null;
      let abort = false;
      for (let reciever of localReceivers) {
        if (self_phone == reciever.number) {
            selfReciever = reciever.number;
        }else{
          let found = await whatsapp.checkDestination(reciever.number)
          if (found) {
            validReciever.push(reciever.number);
          }else if(found === false){
            invalidReceiver.push(reciever.number);
          }else{
            abort  = true;
          }
        }
      }
      if (abort) {
        for (let reciever of localReceivers) {
          insertNumberSentLog('abort', reciever.number, 'Nomor Whatsapp Offline')
        }
      }else{
        if (user.is_subscription_service || payWithCredit(messageSentLog, 'out_forward_message', validReciever.length)) {
          for(let number of validReciever) {
            whatsapp.sendMessage(number, content)
            .then(({data}) => {
              data = cloneWithoutHiddenData(data);
              insertNumberSentLog('success', number, 'Pesan Terkirim', {
                send_json: data,
                id_stanza: getChatId(data)
              })
            }).catch(err => {
              insertNumberSentLog('success', number, 'Pesan Terkirim')
              console.log(err)
            })
          }
          for(let number of invalidReceiver) {
            insertNumberSentLog('failed', number, 'Nomor Tujuan Tidak Valid')
          }
          if (selfReciever) {
            insertNumberSentLog('failed', selfReciever, 'Nomor Tujuan Adalah Diri Sendiri')
          }
        }else{
          for (let reciever of localReceivers) {
            insertNumberSentLog('abort', reciever.number, 'Kredit tidak mencukupi')
          }
        }
      }
    }
    
    if (mainHasReceivers) {
      await doForward(out_receivers.filter(orev => orev.number != remoteJid))
    }
    if (specifiedHasReceivers) {
      for(let j in out_senders) {
        await doForward(out_senders[j].outForwardReceivers.filter(orev => orev.number != remoteJid), out_senders[j])
      }
    }
  }

  async function chatBotFeature(remoteJid, msg) {
    if (!service.feature_chat_bot_google || !(service.is_chat_bot_google || service.is_chat_welcome_message || service.is_chat_away_message)) return;

    if (msg.fromMe || !msg.body || whatsapp.jid.isJidGroup(remoteJid)) return;

    const self_phone = service.phone_auth;
    const cost_credits = user.is_subscription_service ? 0 : service.cost_per_forward;
    const text = msg.body;

    const doBotReply = async (text_reply, send_event) => {
      const messageSentLog = await service.createMessageSentLog({
        message : text_reply,
        event: send_event,
        processed_messages: 1,
        phone_auth: self_phone,
        status: 'complete'
      }).catch(err => null);

      const insertNumberSentLog = (status, message, payload = null) => {
        messageSentLog.createMessageNumberSentLog({
          number: remoteJid,
          entity: [remoteJid],
          status: status,
          response: message,
          id_stanza: payload ? payload.id_stanza : null,
          send_json: payload ? payload.send_json : null,
          cost_credits: status == 'success' ? cost_credits : 0
        });
      }

      if (user.is_subscription_service || payWithCredit(messageSentLog, send_event)) {
        whatsapp.sendMessage(remoteJid, {text: text_reply})
        .then(({data}) => {
          data = cloneWithoutHiddenData(data);
          insertNumberSentLog('success', 'Pesan Terkirim', {
            send_json: data,
            id_stanza: getChatId(data)
          })
        }).catch(err => {
          insertNumberSentLog('success', 'Pesan Terkirim')
          console.log(err)
        })
      }else{
        insertNumberSentLog('abort', 'Kredit tidak mencukupi')
      }
    }

    if (service.is_chat_welcome_message) {
      await sequelize.query(
        "SELECT `chatbot_sheets`.`id`, `chatbot_sheets`.`reply`, `chatbot_sheets`.`interval` FROM `chatbot_sheets` " +
        "WHERE `chatbot_sheets`.`whatsapp_service_id` = "+service.id+" " +
        "AND `chatbot_sheets`.`type` = 'welcome' " +
        "LIMIT 1",
        { type: "SELECT" }
      ).then(async ([ botReply ]) => {
        if (!botReply) return;
        const newMeet = await activity.retrieveChat(remoteJid, botReply.interval).catch(() => {})
        if (newMeet) await doBotReply(botReply.reply, 'chat_bot_welcome_reply');
      }).catch(e => {console.log(e)})
    }
    if (service.is_chat_bot_google) {
      await sequelize.query(
        "SELECT `chatbot_sheets`.`id`, `chatbot_sheets`.`reply` FROM `chatbot_sheets` " +
        "WHERE `chatbot_sheets`.`whatsapp_service_id` = "+service.id+" " +
        "AND ((`chatbot_sheets`.`type` = '2' AND '"+text.replace("'", "\'")+"' LIKE CONCAT('%', `chatbot_sheets`.`message`, '%')) " +
        "OR (`chatbot_sheets`.`type` = '1' AND `chatbot_sheets`.`message` = '"+text.replace("'", "\'")+"')) " +
        "LIMIT 1",
        { type: "SELECT" }
      ).then(async ([ botReply ]) => {
        if (!botReply) return;
        await doBotReply(botReply.reply, 'chat_bot_reply')
      }).catch(e => {console.log(e)})
    }
  }

  return {
    featureHandlers,
    awayTracks
  }
}

exports.useMBSFeature = useMBSFeature
