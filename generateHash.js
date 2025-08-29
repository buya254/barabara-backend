const bcrypt = require("bcrypt"); 

const generateHash = async (plainText) => {
  const hash = await bcrypt.hash(plainText, 10);
  console.log(`Hashed password for '${plainText}':\n${hash}`);
};

generateHash("TLmbtS0@."); 
