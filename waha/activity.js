const sqlite3 = require('sqlite3').verbose();
const moment = require('moment');

exports.useSqlTrack = function (dbName) {
  const db = new sqlite3.Database(`activity_whiskey/${dbName}.db`);
  
  db.serialize(() => {
    db.run('CREATE TABLE IF NOT EXISTS `activity` (`id` TEXT PRIMARY KEY, `latest` TIMESTAMP)');
  });

  function updateChatTime(phone, time) {
    const momentTime = moment.unix(time)
    db.serialize(() => {
      const stmt = db.prepare('INSERT OR REPLACE INTO `activity` (`latest`, `id`) VALUES (?, ?)');
      const stringTime = momentTime.format("YYYY-MM-DD HH:mm:ss")
      stmt.run(stringTime, phone);
      stmt.finalize();
    });
  }
  
  function retrieveChat(phone, minute = null) {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM `activity` WHERE `id` = '"+phone+"'", (err, row) => {
        if (err) return reject(err);
        if (row) {
          db.get("SELECT * FROM `activity` WHERE `id` = '"+phone+"'" + (minute === null ? "" : " AND DATETIME(`activity`.`latest`, '+"+minute+" MINUTES') < date'"+moment().format("YYYY-MM-DD HH:mm:ss")+"'"), (err, row) => {
            if (err) return reject(err);
            resolve(!!row)
          });
        }else{
          resolve(true);
        }
      });
    })
  }

  function getAwayNumbers(minute, now) {
    return new Promise((resolve, reject) => {
      const seconds = minute*60;
      db.all("SELECT * FROM `activity` WHERE `id` != 'me' AND DATETIME(`activity`.`latest`, '+"+(seconds)+" SECONDS') >= '"+now.format("YYYY-MM-DD HH:mm:ss")+"' AND DATETIME(`activity`.`latest`, '+"+(seconds+60)+" SECONDS') < '"+now.format("YYYY-MM-DD HH:mm:ss")+"'", (err, rows) => {
        if (err) return reject(err);
        resolve(rows)
      });
    })
  }

  return {updateChatTime, retrieveChat, getAwayNumbers, db}
}
