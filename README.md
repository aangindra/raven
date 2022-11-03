## Whatsapp Gateway

### Installation

- Clone the repo
- add .env inside the destination folder
- add these variables:

```sh
API_PORT=
WA_SESSION=
SECRET_KEY=

MONGOD_HOST=localhost
MONGOD_PORT=27017
MONGOD_DB=
MONGOD_USERNAME=
MONGOD_PASSWORD=
MONGOD_AUTH_SOURCE=

AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

```

---

#### Shared Node Modules and .next Releases

##### GIT PULL AND REMOVE NODE_MODULES

```sh
git checkout . && git pull && rm -rf node_modules && ln -s ../api/node_modules/
ln -s ../api/tokens
ln -s ../api/log_qr
```

##### SETUP API

```sh
pm2 delete --silent api
pm2 start -n api-whatsapp-gateway dante.js --silent
```

##### SETUP SENDER WA GATEWAY

```sh
pm2 delete --silent wa_{phone}
pm2 start -n wa-{phone} wa_gateway.js --silent
```
