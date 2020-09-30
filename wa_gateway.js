require('dotenv').config();
const venom = require('venom-bot');
const { writeFileSync, existsSync, mkdirSync } = require('fs');
const dayjs = require('dayjs');
const schedule = require('node-schedule');
const axios = require('axios');
const fs = require('fs');
const WA_SESSION = process.env.WA_SESSION ? process.env.WA_SESSION : 'default0';
const mongodbConnection = require('./mongodb_connection');

const start = async () => {
	const collection = await mongodbConnection('WA');
	console.log(WA_SESSION);
	const client = await venom.create(
		WA_SESSION,
		(base64Qr, asciiQR) => {
			if (!existsSync(`./log_qr`)) {
				mkdirSync(`./log_qr`, { recursive: true });
			}
			exportQR(base64Qr, `log_qr/qrCode_${WA_SESSION}.png`);
		},
		(statusSession) => {
			console.log(statusSession);
		},
		{
			headless: true, // Headless chrome
			devtools: false, // Open devtools by default
			useChrome: true, // If false will use Chromium instance
			debug: false, // Opens a debug session
			logQR: true, // Logs QR automatically in terminal
			browserArgs: [ '--no-sandbox' ], // Parameters to be added into the chrome browser instance
			refreshQR: 15000, // Will refresh QR every 15 seconds, 0 will load QR once. Default is 30 seconds
			autoClose: false, // Will auto close automatically if not synced, 'false' won't auto close. Default is 60 seconds (#Important!!! Will automatically set 'refreshQR' to 1000#)
			disableSpins: true, // Will disable Spinnies animation, useful for containers (docker) for a better log
      disableWelcome: true,
      autoClose: 30000
		}
  );
  client.onStateChange((state) => {
    const conflits = [
      venom.SocketState.CONFLICT,
      venom.SocketState.UNPAIRED,
      venom.SocketState.UNLAUNCHED,
    ];
    if (conflits.includes(state)) {
      client.useHere();
      if(state === "UNPAIRED"){
        console.log("WA DISCONNECTED!");
      }
    }
  });
  const isConnected = await client.isConnected();
	schedule.scheduleJob('*/10 * * * * *', async () => {
    if(isConnected){
      await sendMessage(client, collection);
      await sendMessageSchedule(client, collection);
    }else{
      console.log("Whatsapp not connected!");
    }
	});
	return 'success';
};

const sendMessage = async (client, collection) => {
	const foundMessage = await collection('Messages').findOne({
		sender: WA_SESSION,
		$or: [
			{
				sentAt: {
					$exists: false
				},
				errorAt: {
					$exists: false
				}
			}
		]
	});

	if (!client) {
		console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', 'Device not connected!');
		await updateStatusDevice(WA_SESSION, 'DISCONNECTED', collection);
		// delete file qr and token
		let pathQrCode = __dirname + `/log_qr/qrCode_${WA_SESSION}.png`;
		let pathTokens = __dirname + `/tokens/${WA_SESSION}.data.json`;
		try {
			if (fs.existsSync(pathQrCode)) {
				fs.unlinkSync(pathQrCode);
			}
			if (fs.existsSync(pathTokens)) {
				fs.unlinkSync(pathTokens);
			}
		} catch (e) {
			console.log(e);
		}
		return false;
  }
	if (!foundMessage) {
		console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', 'not found message...');
		return false;
	} else {
		console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', `found message for ${foundMessage.phone}!`);
	}
	try {
		const validPhone = await client.getNumberProfile(`${foundMessage.phone}@c.us`);
		if (validPhone === 404) {
			await collection('Messages').updateOne(
				{
					_id: foundMessage._id
				},
				{
					$set: {
						errorMessage: validPhone,
						errorAt: dayjs().toISOString(),
						_updatedAt: dayjs().toISOString()
					}
				}
			);
			console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', `${foundMessage.phone} not have whatsapp!`);
			return false;
		}
		let result;
		if (foundMessage.type === 'IMAGE' && foundMessage.image) {
			const splitFilename = foundMessage.image.split('/');
			const filename = splitFilename[splitFilename.length - 1];
			result = await new Promise((resolve, reject) => {
				client
					.sendImage(
						`${foundMessage.phone}@c.us`,
						`${foundMessage.image}`,
						`${filename}`,
						`${foundMessage.message}`
					)
					.then((result) => {
						resolve('success');
					})
					.catch((error) => {
						console.log('error', error);
						resolve(false);
					});
			});
		} else if (foundMessage.type === 'FILE' && foundMessage.file) {
			const files = await getDocumentFromUrl(foundMessage.file);
			const splitFilename = foundMessage.file.split('/');
			const filename = splitFilename[splitFilename.length - 1];
			result = await client.sendText(`${foundMessage.phone}@c.us`, foundMessage.message);
			result = await new Promise((resolve, reject) => {
				client
					.sendFileFromBase64(`${foundMessage.phone}@c.us`, `${files}`, `${filename}`, `${filename}`)
					.then((result) => {
						resolve('success');
					})
					.catch((error) => {
						console.log('error', error);
						resolve(false);
					});
			});
		} else {
      result = await client.sendText(`${foundMessage.phone}@c.us`, foundMessage.message);
		}

		if (!result) {
			console.warn(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', 'Whatsapp not connected!');
		} else {
			await collection('Messages').updateOne(
				{
					_id: foundMessage._id
				},
				{
					$set: {
						sentAt: dayjs().toISOString(),
						_updatedAt: dayjs().toISOString()
					}
				}
			);
			console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', `message for ${foundMessage.phone} is sent!`);
		}
	} catch (e) {
		await collection('Messages').updateOne(
			{
				_id: foundMessage._id
			},
			{
				$set: {
					errorMessage: "error venom",
					errorAt: dayjs().toISOString(),
					_updatedAt: dayjs().toISOString()
				}
			}
		);
		console.log(e);
	}
	return true;
};
const sendMessageSchedule = async (client, collection) => {
	const foundMessage = await collection('Messages').findOne({
		sender: WA_SESSION,
		isScheduled: true,
		$or: [
			{
				sentAt: {
					$exists: false
				},
				errorAt: {
					$exists: false
				}
			}
		]
	});

	if (!client) {
		console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', 'Device not connected!');
		await updateStatusDevice(WA_SESSION, 'DISCONNECTED', collection);
		// delete file qr and token
		let pathQrCode = __dirname + `/log_qr/qrCode_${WA_SESSION}.png`;
		let pathTokens = __dirname + `/tokens/${WA_SESSION}.data.json`;
		try {
			if (fs.existsSync(pathQrCode)) {
				fs.unlinkSync(pathQrCode);
			}
			if (fs.existsSync(pathTokens)) {
				fs.unlinkSync(pathTokens);
			}
		} catch (e) {
			console.log(e);
		}
		return false;
	}
	if (!foundMessage) {
		console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', 'not found schedule message...');
		return false;
	}
	if (foundMessage._createdAt <= new Date()) {
		console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', 'message are still below schedule...');
		return false;
	} else {
		console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'));
	}
	try {
		const validPhone = await client.getNumberProfile(`${foundMessage.phone}@c.us`);
		if (validPhone === 404) {
			await collection('Messages').updateOne(
				{
					_id: foundMessage._id
				},
				{
					$set: {
						errorMessage: validPhone,
						errorAt: dayjs().toISOString(),
						_updatedAt: dayjs().toISOString()
					}
				}
			);
			console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', `${foundMessage.phone} not have whatsapp!`);
			return false;
		}
		let result;
		if (foundMessage.type === 'IMAGE') {
			const splitFilename = foundMessage.image.split('/');
			const filename = splitFilename[splitFilename.length - 1];
			result = await new Promise((resolve, reject) => {
				client
					.sendImage(
						`${foundMessage.phone}@c.us`,
						`${foundMessage.image}`,
						`${filename}`,
						`${foundMessage.message}`
					)
					.then((result) => {
						resolve('success');
					})
					.catch((error) => {
						console.log('error', error);
						resolve(false);
					});
			});
		} else if (foundMessage.type === 'FILE') {
			const files = await getDocumentFromUrl(foundMessage.file);
			const splitFilename = foundMessage.file.split('/');
			const filename = splitFilename[splitFilename.length - 1];
			result = await client.sendText(`${foundMessage.phone}@c.us`, foundMessage.message);
			result = await new Promise((resolve, reject) => {
				client
					.sendFileFromBase64(`${foundMessage.phone}@c.us`, `${files}`, `${filename}`, `${filename}`)
					.then((result) => {
						resolve('success');
					})
					.catch((error) => {
						console.log('error', error);
						resolve(false);
					});
			});
		} else {
			result = await client.sendText(`${foundMessage.phone}@c.us`, foundMessage.message);
		}

		if (!result) {
			console.warn(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', 'Whatsapp not connected!');
		} else {
			await collection('Messages').updateOne(
				{
					_id: foundMessage._id
				},
				{
					$set: {
						sentAt: dayjs().toISOString(),
						_updatedAt: dayjs().toISOString()
					}
				}
			);
			console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', `message for ${foundMessage.phone} is sent!`);
		}
	} catch (e) {
		await collection('Messages').updateOne(
			{
				_id: foundMessage._id
			},
			{
				$set: {
					errorMessage: "error venom",
					errorAt: dayjs().toISOString(),
					_updatedAt: dayjs().toISOString()
				}
			}
		);
		console.log(e);
	}
	return true;
};
const getDocumentFromUrl = async (url) => {
	let res;
	try {
		res = await axios.get(url, {
			responseType: 'arraybuffer'
		});
		return `data:${res.headers['content-type']};base64,${Buffer.from(
			String.fromCharCode(...new Uint8Array(res.data)),
			'binary'
		).toString('base64')}`;
	} catch (err) {
		console.log(err);
	}
};
// Writes QR in specified path
const exportQR = (qrCode, path) => {
	qrCode = qrCode.replace('data:image/png;base64,', '');
	const imageBuffer = Buffer.from(qrCode, 'base64');
	writeFileSync(path, imageBuffer);
};

const updateStatusDevice = async (phone, status, collection) => {
	await collection('Devices').updateOne(
		{
			phone
		},
		{
			$set: {
				status
			}
		}
	);
};

start();
