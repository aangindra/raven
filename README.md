## School Talk Dashboard

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
git checkout . && git pull && rm -rf node_modules && ln -s ../aaa/node_modules/ && rm -rf release && ln -s ../aaa/.next/ release
```

##### SETUP API

```sh
pm2 delete --silent wa_{phone}
pm2 start -n wa_{phone} wa_gateway.js --silent
```
##### ADD WHATSAPP STUDENT BILL REMINDER #####
```sh
pm2 start -n whatsapp-student-bill-reminder-smatrimurti utilities/whatsapp-student-bill-reminder.js --silent
```