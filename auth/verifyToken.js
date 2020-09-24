let jwt = require('jsonwebtoken');
const SECRET_KEY = process.env.SECRET_KEY ? process.env.SECRET_KEY : uuidV4();
const HEADER_REGEX = /Bearer token-(.*)$/;

exports.verifyToken = (req, res, next) => {
  let token = req.headers['authorization'];
  if (!token)
    return res.status(403).send({ auth: false, message: 'No token provided.' });
    
  jwt.verify(token, SECRET_KEY, function(err, decoded) {
    if (err)
    return res.status(500).send({ auth: false, message: 'Failed to authenticate token.' });
      
    // if everything good, save to request for use in other routes
    req.userId = decoded.id;
    next();
  });
}

exports.authenticate = async (req, dataLoader) => {
  try {
    // console.log("Authorization header", req.headers.authorization);
    if (!req.headers.authorization) {
      return null;
    }
    const token = req.headers.authorization
    if (!token) {
      return null;
    }
    const { _id } = jwt.verify(token, SECRET_KEY);
    return {
      _id,
      token
    };
  } catch (err) {
    console.log("AUTHENTICATE ERROR:", err.message);
    return null;
  }
};

// module.exports = verifyToken;