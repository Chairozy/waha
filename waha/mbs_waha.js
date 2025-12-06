const { office } = require("./office");
const { MessageNumberSentLog } = require("./db");
const mime = require("mime-types");
const { Op, Sequelize } = require("sequelize");
const axios = require('axios');
const moment = require('moment');
const { phoneNumberFormatter } = require("./WhatsAppHttpApi");

const hostUrl = 'https://api.whatsapp.maestrobyte.com';

function useMBSMessage (whatsapp, service, user) {

  class Magazine {
    constructor(messageSentLog, process, destroy = () => {}) {
      this.abortReason = {
        offline: 'Nomor Whatsapp Offline',
        credit: 'Kredit tidak mencukupi',
        abort: 'Dibatalkan oleh user'
      };
      this.content = null;
      this.messageSentLog = messageSentLog;
      this.process = process;
      this.process.abort = this.messageSentLog.status == 'process' ? null : this.messageSentLog.status;
      this.numbers = [];
      this.fileData = null;
      this.waiting_response = false;
      this.destroy = destroy;
      this.now = null;
      this.childs = [];
    }

    async createContent () {
      const messageMediaSentLog = await this.messageSentLog.getMessageMediaSentLog(),
        generated_content = this.messageSentLog.generated_content && JSON.parse(this.messageSentLog.generated_content),
        has_generated = generated_content && typeof generated_content === 'object' && !Array.isArray(generated_content),
        contentKeys = has_generated ? Object.keys(generated_content) : [];

      const contentBuilder = whatsapp.createContent();
      
      if (messageMediaSentLog) {
        if (!this.fileData) this.fileData = await this.getBuffer(messageMediaSentLog.url);
        return contentBuilder.file(this.fileData.toString("base64"), messageMediaSentLog.name, mime.lookup(messageMediaSentLog.name));
      }else{
        if (has_generated && contentKeys.includes('contacts')) {
          return contentBuilder.contacts(...generated_content.contacts);
        }else if (has_generated && contentKeys.includes('latitude') && contentKeys.includes('longitude')){
          return contentBuilder.location(generated_content.title, generated_content.latitude, generated_content.longitude);
        }
      }
      return contentBuilder;
    }

    async getBuffer (url, options) {
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
    }
  
    async loadNumber (limit = 10) {
      this.numbers = await this.messageSentLog.getMessageNumberSentLogs({
        where : {
          status: null,
          id: {
            [Op.notIn]: this.numbers.map(item => item.id)
          }
        },
        limit
      })
    }

    async toAbortStatus (response = null) {
      const payload = {status: 'failed', cost_credits: 0};
      if (response) {
        payload.response = response;
      }
      this.numbers = await MessageNumberSentLog.update(payload, {where : {status: null, message_sent_log_id: this.messageSentLog.id}})
    }
    
    async numberFailed (messageNumberSentLog) {
      console.log(messageNumberSentLog.number, "failed");
      messageNumberSentLog.cost_credits = 0;
      messageNumberSentLog.status = 'failed';
      messageNumberSentLog.response = 'Nomor Tujuan Tidak Valid';
      messageNumberSentLog.save({fields: ["number", "cost_credits", "status", "response"]});
    }
    
    async numberSuccess (messageNumberSentLog) {
      console.log(messageNumberSentLog.number, "success");
      messageNumberSentLog.status = 'success';
      messageNumberSentLog.response = 'Pesan Terkirim';
      messageNumberSentLog.save({fields: ["number", "status", "response"]});
    }
  
    async updateMessageStartStatus() {
      this.now = moment();
      await service.reload();
      this.content = await this.createContent();
      let querySave = ['status'];
      if (!this.messageSentLog.status) {
        querySave.push('send_at');
        this.messageSentLog.send_at = this.now.format('YYYY-MM-DD HH:mm:ss');
      }
      this.messageSentLog.status = 'process';
      await this.messageSentLog.save({fields: querySave});
    }

    async play () {
      let n = 0;
      if (!this.process.abort) {
        await this.updateMessageStartStatus();
        for (let ic = 0; ic < this.childs.length; ic++) {
          await this.childs[ic].updateMessageStartStatus();
        }
        await this.loadNumber();
        let first_sent = true;
        while(this.numbers.length > 0 && !this.process.abort) {
          const messageNumberSentLog = this.numbers[n];
          if (messageNumberSentLog) {
            if (first_sent && !this.hasParallel) {
              office.firstParallel = true;
            }else if (first_sent && office.firstParallel) {
              office.firstParallel = false;
            }else if (!first_sent){
              await office.parallelPromise();
            }else{
              await office.parallelPromise();
            }
            first_sent = false;
            // if ((user.credits - service.cost_per_message) > 0.00) {
              console.log("proses kirim");
              let pending = await this.sent(messageNumberSentLog);
              if (pending) {
                  console.log("pending kirim")
                  return;
              }
            // }else{
            //   this.process.abort = 'credit';
            // }
          }else{
            await this.loadNumber();
            n = -1;
          }
          n++;
        }
      }
      this.endPlay();
    }

    async endPlay() {
      await this.updateMessageFinishStatus();
      for (let ic = 0; ic < this.childs.length; ic++) {
        await this.childs[ic].updateMessageFinishStatus();
      }

      if (!user.is_subscription_service) {
        const used = await MessageNumberSentLog.sum(
          'cost_credits',
          {
            where: {
              message_sent_log_id: this.messageSentLog.id,
              status: 'success',
            }
          }
        );
        const latestCreditHistory = await this.messageSentLog.getCreditHistory({
          where: {
            event: {
              [Op.in]: ['send_message', 'api_send_message']
            },
          }
        });
        if (latestCreditHistory) {
          const refund = latestCreditHistory.amount_change_in_credits - used;
          if (refund > 0) {
            await user.reload();
            const credit_before_changes = user.credits,
              amount_change_in_credits = refund,
              latest_credit = credit_before_changes + amount_change_in_credits;
            user.credits += amount_change_in_credits;
            await user.save({fields:["credits"]});
            await this.messageSentLog.createCreditHistory({
              user_id: user.id,
              event: 'refund',
              credit_before_changes,
              amount_change_in_credits,
              latest_credit
            });
          }
        }
      }
      if (this.messageSentLog.event == 'send_message') {
          axios.post(`${hostUrl}:${5306}/api/cs/notify`, {
              id: this.messageSentLog.id,
              notif: 'end',
              now: this.now.format('YYYY-MM-DD HH:mm')
          }, {
              headers: {
                authorization: '12345'
              },
          });
      }
      await (new Promise(r => setTimeout(r, office.randomTicks())));

      this.destroy();
    }

    async updateMessageFinishStatus() {
      if (this.process.abort) {
        const reason = this.abortReason[this.process.abort] || null;
        await this.toAbortStatus(reason);
        // if (this.process.abort == 'clear') {
        //   office.replaceQueue([]);
        // }
        this.messageSentLog.status = 'abort';
      }else{
        this.messageSentLog.status = 'complete';
      }
      await this.messageSentLog.save({fields: ['status']});
    }

    async sent (messageNumberSentLog) {
      const number = phoneNumberFormatter(messageNumberSentLog.number);
      messageNumberSentLog.number = number;
      if (typeof messageNumberSentLog.entity === 'string') {
        messageNumberSentLog.entity = JSON.parse(messageNumberSentLog.entity);
      }
      const found = await whatsapp.checkDestination(number);
      if (found === true) {
        (async () => {
          await this.send(messageNumberSentLog);
          for (let ic = 0; ic < this.childs.length; ic++) {
            await this.childs[ic].send(messageNumberSentLog);
          }
        })()
        await this.numberSuccess(messageNumberSentLog);
      } else if (found === false) {
        await this.numberFailed(messageNumberSentLog);
      } else {
        // this.process.abort = 'offline';
        office.replaceQueue([]);
        this.destroy();
        return true;
      }
      return false;
    }

    async send (messageNumberSentLog) {
      const content = this.content.clone();
      if (this.messageSentLog.message) {
        content.message(this.messageSentLog.message).mentions();
        if (messageNumberSentLog.entity) {
          content.message(content._content.text.replace(/{{\w}}/g, (x) => {
            return messageNumberSentLog.entity[x[2].toUpperCase().charCodeAt(0) - 65];
          }));
        }
      }
      
      return whatsapp.sendMessage(
        content.chat(messageNumberSentLog.number)
      );
    }
  }

  office.command = async (id, next) => {
    const process = office.process.get(id);
    if (process.with_message_id) {
      office.remove(process.with_message_id);
      const messageSentLog = await service.getMessageSentLog({ where : { id : id } });
      const messageSentLog2 = await service.getMessageSentLog({ where : { id : process.with_message_id } });
      let magazine, child;
      if (parseInt(process.id) < parseInt(process.with_message_id)) {
        magazine = new Magazine(messageSentLog, process, next)
        child = new Magazine(messageSentLog2, process);
      }else{
        magazine = new Magazine(messageSentLog2, process, next)
        child = new Magazine(messageSentLog, process);
      }
      magazine.childs = [child]
      magazine.play();
    }else{
      const messageSentLog = await service.getMessageSentLog({ where : { id : id } });
      const magazine = new Magazine(messageSentLog, process, next);
      magazine.play();
    }
  }

  function insertQueue(id, date = undefined, notif = true) {
    console.log(id)
    if (typeof id === "string") {
      office.add(id, date);
    }else if(typeof id === "object" && id.id && id.with_message_id) {
      office.add(id, date);
      id = id.id;
    }else return;
    if (notif) {
      axios.post(`${hostUrl}:${5306}/api/cs/notify`, {
        id: id,
        notif: 'start'
      }, {
        headers: {
          authorization: '12345'
        },
      });
    }
    return office.toProcess();
  }

  function startWatch() {
    office.start()
  }

  function freshDatabaseQueue() {
    if (office.beforeProcess) return;
    office.beforeProcess = async () => {
      const queue = [];
      const messageSentLogs = await service.getMessageSentLogs({
        where : {
          // [Op.and]: [
          //   Sequelize.literal('exists (SELECT message_number_sent_logs.id FROM message_number_sent_logs WHERE message_number_sent_logs.status IS NULL LIMIT 1)'),
          // ],
          [Op.or]: [
            {status: null},
            {status: 'process'},
          ]
        },
        order: [
          ['createdAt', 'ASC'],
          ['id', 'ASC']
        ]
      });
      console.log("IIINIIIIIII")
      for(let i in messageSentLogs) {
        queue.push({id: messageSentLogs[i].id, with_message_id: messageSentLogs[i].second_of_message_id, date: messageSentLogs[i].schedule || undefined})
      }
      setTimeout(() => {
        console.log('replace')
        office.replaceQueue(queue);
      }, 10000)
      // office.replaceQueue(queue);
    }
  }

  function remove(id) {
    const result = office.remove(id);
    if (office.process.has(id)) {
      [...office.process.keys()].forEach((kid) => {
        office.process.get(kid).abort = 'abort';
      })
      return true;
    }
    return result;
  }

  return {
    freshDatabaseQueue,
    insertQueue,
    startWatch,
    remove
  }
}

exports.useMBSMessage = useMBSMessage
