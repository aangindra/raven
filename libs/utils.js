const { get, sample, keyBy } = require("lodash");
const PhoneNumber = require("awesome-phonenumber");
const LIST_NOTIFICATION_TYPE = {
  GENERAL: "GENERAL",
  OTP: "OTP",
  PPDB: "PPDB",
  EMPLOYEE_PRESENCE: "EMPLOYEE_PRESENCE",
  STUDENT_PRESENCE: "STUDENT_PRESENCE",
  STUDENT_BILL_PAYMENT: "FINANCE",
};

const LIST_PHONE = {
  phone1: "628175121712",
  phone2: "6282110732206",
};

const BLACKLIST_PHONE_NUMBER = {
  [LIST_PHONE.phone1]: "6285157574640",
  [LIST_PHONE.phone2]: "62859106505353",
};

const utils = {
  appName: "Whatsapp-Gateway",
  appVersion: "0.0.1",
  service: "running",
  mobileNumberLocale: "en-IN",
  minPasswordLength: 6,
  devicePlatforms: {
    ANDROID: "android",
    IOS: "ios",
  },
  user: {
    status: {
      ACTIVE: "active",
      DISABLED: "disabled",
    },
  },
  generateOtp: () => {
    return Math.floor(1000 + Math.random() * 9000);
  },
  formatPhone: (phone, region = "ID") => {
    if (phone != undefined) {
      const getPhone = new PhoneNumber(phone, region);
      return getPhone.getNumber().replace(/[^0-9\\.]+/g, "");
    } else {
      return phone;
    }
  },
  assignSenderByNotificationType: ({ devices, message }) => {
    const indexedSenderByPhone = keyBy(devices, "phone");
    const isBlacklisted = get(BLACKLIST_PHONE_NUMBER, message.sender);
    if (isBlacklisted) {
      return BLACKLIST_PHONE_NUMBER[message.sender];
    }

    if (
      indexedSenderByPhone[message.sender] &&
      !indexedSenderByPhone[message.sender].isLoadBalancer
    ) {
      console.log(
        "sender is not changing",
        message.sender,
        indexedSenderByPhone[message.sender].isLoadBalancer
      );
      return message.sender;
    }
    const indexedSenderByNotificationType = devices
      .filter((device) => device.isLoadBalancer)
      .reduce((acc, device) => {
        if (device.notificationType) {
          for (let type of device.notificationType) {
            if (!acc[type]) {
              acc[type] = [];
            }
            acc[type].push(device.phone);
          }
        }
        return acc;
      }, {});

    const notificationType = get(
      LIST_NOTIFICATION_TYPE,
      message.notificationType
    );
    console.log("message", message);
    console.log("notificationType", notificationType);
    console.log(
      "indexedSenderByNotificationType",
      indexedSenderByNotificationType[notificationType]
    );
    if (
      !notificationType ||
      !indexedSenderByNotificationType[notificationType]
    ) {
      console.log(
        "sender is not changing",
        message.sender,
        indexedSenderByPhone[message.sender].isLoadBalancer
      );
      return message.sender;
    }

    if (indexedSenderByNotificationType[notificationType].length === 0) {
      console.log(
        "sender is not changing",
        message.sender,
        indexedSenderByPhone[message.sender].isLoadBalancer,
        indexedSenderByNotificationType[notificationType].length
      );
      return message.sender;
    }

    return sample(indexedSenderByNotificationType[notificationType]);
  },
};

module.exports = utils;
