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

const start = async () => {
	try {
		let client = await new Promise((resolve, reject) => {
			venom.create(
				'sessionName',
				(base64Qr, asciiQR) => {
          if (!existsSync(`./log_qr`)) {
            mkdirSync(`./log_qr`, { recursive: true });
          }
          let matches = base64Qr.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/),
            response = {};
    
          if (matches.length !== 3) {
            return new Error('Invalid input string');
          }
          response.type = matches[1];
          response.data = new Buffer.from(matches[2], 'base64');
    
          let imageBuffer = response;
          fs.writeFile(
            `log_qr/qrCode_session.png`,
            imageBuffer['data'],
            'binary',
            function (err) {
              if (err != null) {
                console.log(err);
              }
            }
          );
        },
				(statusSession) => {
          console.log('Status Session: ', statusSession);
          if (statusSession === 'isLogged') {
            resolve(statusSession);
          }
					//return isLogged || notLogged || browserClose || qrReadSuccess || qrReadFail || autocloseCalled
				},
				venomOptions
			);
		});
		// client = venom.create(
		// 	'sessionName',
		// 	undefined,
		// 	(statusSession) => {
		// 		console.log('Status Session: ', statusSession);
		// 		//return isLogged || notLogged || browserClose || qrReadSuccess || qrReadFail || autocloseCalled
		// 	},
		// 	venomOptions
		// );
	} catch (e) {
		console.log(e);
	}

	return 'success';
};
start();
