const lodash = require('lodash');
const PhoneNumber = require('awesome-phonenumber');

const utils = {
  appName: 'Whatsapp-Gateway',
  appVersion: '0.0.1',
  service: 'running',
  mobileNumberLocale: 'en-IN',
  minPasswordLength: 6,
  devicePlatforms: {
    ANDROID: 'android',
    IOS: 'ios'
  },
  user: {
    status: {
      ACTIVE: 'active',
      DISABLED: 'disabled'
    }
  },
  generateOtp: () => {
    return Math.floor(1000 + Math.random() * 9000);
  },
  formatPhone: (phone, region = 'ID') => {
    if (phone != undefined) {
      const getPhone = new PhoneNumber(phone, region);
      return getPhone.getNumber().replace(/[^0-9\\.]+/g, '');
    } else {
      return phone
    }
  }
};
module.exports = utils;