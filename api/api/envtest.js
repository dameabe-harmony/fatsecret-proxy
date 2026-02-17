module.exports = async (req, res) => {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");

  const hasKey = !!process.env.FATSECRET_KEY;
  const hasSecret = !!process.env.FATSECRET_SECRET;

  // Show only safe info (NOT the values)
  res.end(JSON.stringify({
    hasKey,
    hasSecret,
    fatsecretKeysSeen: Object.keys(process.env).filter(k => k.includes("FATSECRET")),
    nodeVersion: process.version
  }));
};
