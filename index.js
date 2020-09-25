require('dotenv').config();
const fs = require('fs');
const venom = require('venom-bot');
const { writeFileSync, existsSync, mkdirSync } = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const dayjs = require('dayjs');
const uuidV4 = require('uuid/v4');
const cors = require('cors');
const mongodbConnection = require('./mongodb_connection');
const { body: bodyValidator, validationResult } = require('express-validator');
const path = require('path');
const SECRET_KEY = process.env.SECRET_KEY ? process.env.SECRET_KEY : uuidV4();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { verifyToken, authenticate } = require('./auth/verifyToken');

const start = async () => {
	const collection = await mongodbConnection('WA');
	let app = express();
	const corsOptions = {
		optionsSuccessStatus: 200
	};
	// PreFLIGHT!
	app.options('*', cors(corsOptions));
	app.get('*', cors(corsOptions));
	app.post('*', cors(corsOptions));
	const rawBodySaver = (req, res, buf, encoding) => {
		if (buf && buf.length) {
			req.rawBody = buf.toString(encoding || 'utf8');
		}
	};
	app.use(bodyParser.json({ verify: rawBodySaver }));
	app.use(bodyParser.urlencoded({ verify: rawBodySaver, extended: true }));
	app.use(
		bodyParser.raw({
			verify: rawBodySaver,
			type: () => true
		})
  );
  app.get('/', async(req, res) => {
    return res.status(200).json({ message: "Welcome to API Raven 1.0.0" })
  })
	app.post(
		'/login_whatsapp',
		verifyToken,
		[ bodyValidator('session').notEmpty().withMessage('session cannot be empty!') ],
		async (req, res) => {
			const errors = validationResult(req);
			if (!errors.isEmpty()) {
				return res.status(400).json({ errors: errors.array() });
			}
			console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', 'POST /login');
			const { session } = req.body;
			const venomOptions = {
				headless: true, // Headless chrome
				devtools: false, // Open devtools by default
				useChrome: true, // If false will use Chromium instance
				debug: false, // Opens a debug session
				logQR: true, // Logs QR automatically in terminal
				browserArgs: [ '' ], // Parameters to be added into the chrome browser instance
				refreshQR: 15000, // Will refresh QR every 15 seconds, 0 will load QR once. Default is 30 seconds
				autoClose: false, // Will auto close automatically if not synced, 'false' won't auto close. Default is 60 seconds (#Important!!! Will automatically set 'refreshQR' to 1000#)
				disableSpins: true // Will disable Spinnies animation, useful for containers (docker) for a better log
			};
			const client = await new Promise((resolve, reject) => {
				venom.create(
					session,
					(base64Qr) => {
						if (!existsSync(`./log_qr`)) {
							mkdirSync(`./log_qr`, { recursive: true });
						}
						exportQR(base64Qr, `log_qr/qrCode_${session}.png`);
						resolve(base64Qr);
					},
					(statusFind) => {
						if (statusFind === 'isLogged') {
							resolve(statusFind);
						}
					},
					venomOptions
				);
			});
			if (client === 'isLogged') {
				await collection('Devices').updateOne(
					{
						phone: session
					},
					{
						$set: {
							status: 'CONNECTED'
						}
					}
				);
				return res.status(200).json({ message: 'Success login!', status: client, qrCode: '' });
			}
			return res.status(200).json({ message: 'Success login!', status: 'notLogged', qrCode: client });
		}
	);
	app.post(
		'/register',
		[
			bodyValidator('username').notEmpty().withMessage('username cannot be empty!'),
			bodyValidator('password').notEmpty().withMessage('password cannot be empty!')
		],
		async (req, res) => {
			const errors = validationResult(req);
			if (!errors.isEmpty()) {
				return res.status(400).json({ errors: errors.array() });
			}
			const { username, password } = req.body;

			const hashedPassword = bcrypt.hashSync(password, 8);

			const foundUser = await collection('Accounts').findOne({
				username
			});
			if (foundUser) {
				return res.status(400).json({ success: false, message: 'username has been taken!' });
			}
			const User = {
				_id: uuidV4(),
				username,
				password: hashedPassword,
				_createdAt: new Date().toISOString(),
				_updatedAt: new Date().toISOString()
			};
			await collection('Accounts').insertOne(User);
			const token = jwt.sign({ _id: User._id }, SECRET_KEY);
			await collection('UserTokens').insertOne({
				_id: uuidV4(),
				accountId: User._id,
				_token: token,
				_createdAt: new Date().toISOString(),
				_updatedAt: new Date().toISOString()
			});
			return res.status(200).json({
				message: 'Success register!',
				attributes: {
					username: User.username,
					_token: token,
					_createdAt: User._createdAt
				}
			});
		}
	);
	app.get('/me', verifyToken, async (req, res) => {
    const activeSession = await authenticate(req);
    const Account = await collection("Accounts").findOne({
      _id: activeSession._id
    },{
      projection: {
        password: 0
      }
    });
		return res.status(200).json({ message: 'success me!', attributes: Account });
	});
	// app.get('/get-qr', verifyToken, async (req, res) => {
	// 	console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', 'GET /get-qr');
	// 	const imageAsBase64 = base64Encode(__dirname + `/log_qr/qrCode_${req.query.session}.png`);
	// 	return res.send(imageAsBase64);
	// });
	// app.post(
	// 	'/disconnect',
	// 	[ bodyValidator('session').notEmpty().withMessage('session cannot be empty!') ],
	// 	async (req, res) => {
	// 		return res.send('oke');
	// 	}
	// );
	app.post(
		'/send_message',
		verifyToken,
		[
			bodyValidator('sender').notEmpty().withMessage('sender cannot be empty!'),
			bodyValidator('phone').notEmpty().withMessage('phone cannot be empty!'),
			bodyValidator('message').notEmpty().withMessage('message cannot be empty!'),
			bodyValidator('type').notEmpty().withMessage('type cannot be empty!')
		],
		async (req, res) => {
			const errors = validationResult(req);
			if (!errors.isEmpty()) {
				return res.status(400).json({ errors: errors.array() });
      }
      const { phone, message, type, image, file, sender } = req.body;
      const activeSession = await authenticate(req);
      if(!activeSession) {
        return res.status(403).json({ message: "Token invalid!" });
      }
      const foundAccount = await collection("Accounts").findOne({
        _id: activeSession._id
      });
      const listDevices = await collection("Devices").find({
        accountId: foundAccount.username
      }).toArray();
      const devices = listDevices.map(device => device.phone);
      if(!devices.includes(sender)){
        return res.status(404).json({ message: "Sender not found!" });
      }
			if (![ 'TEXT', 'IMAGE', 'FILE' ].includes(type)) {
				return res.status(400).json({ errors: { message: 'Wrong type message!' } });
			}

			console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', 'POST /send_message');
			let newMessage = {
				_id: uuidV4(),
				sender,
				phone: '',
				message,
				type,
				isScheduled: false,
				_createdAt: dayjs().toISOString(),
				_updatedAt: dayjs().toISOString()
			};
			if (type === 'IMAGE' && image) {
				newMessage.image = image;
			} else if (type === 'FILE' && file) {
				newMessage.file = file;
			} else {
        newMessage.type = 'TEXT';
      }
			const phones = phone.split(',');
			for (const number of phones) {
				newMessage.phone = number;
				await collection('Messages').insertOne(newMessage);
			}
			return res.status(200).json({ message: 'Success send message!' });
		}
	);
	const PORT = process.env.API_PORT || 3000;
	const serverAfterListening = app.listen(PORT, () => {
		console.log(`WhatsApp API server running on port ${PORT}.`);
	});
	serverAfterListening.setTimeout(600000);
};

// Writes QR in specified path
const exportQR = (qrCode, path) => {
	qrCode = qrCode.replace('data:image/png;base64,', '');
	const imageBuffer = Buffer.from(qrCode, 'base64');
	writeFileSync(path, imageBuffer);
};

const base64Encode = (file) => {
	//read image file
	const data = fs.readFileSync(file);
	//get image file extension name
	let extensionName = path.extname(`${file}`);
	//convert image file to base64-encoded string
	let base64Image = new Buffer(data, 'binary').toString('base64');
	//combine all strings
	let imgSrcString = `data:image/${extensionName.split('.').pop()};base64,${base64Image}`;
	return imgSrcString;
};

start();
