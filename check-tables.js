const { PrismaClient } = require("@prisma/client");
require("dotenv").config({ override: true });

async function main() {
  const prisma = new PrismaClient();
  try {
    const tables = await prisma.$queryRaw`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `;
    console.log("Tables in 'public' schema:");
    console.table(tables);
  } catch (error) {
    console.error("Error checking tables:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
