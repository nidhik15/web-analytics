const { PrismaClient } = require("@prisma/client");
require("dotenv").config({ override: true });

async function main() {
  console.log("Attempting to connect to the database using environment variables...");

  const prisma = new PrismaClient();

  try {
    // Attempt a simple query to verify the connection
    await prisma.$connect();
    console.log("Successfully connected to the database.");

    // Optional: run a raw query to further verify
    const result = await prisma.$queryRaw`SELECT 1 as connected`;
    console.log("Query result:", result);
  } catch (error) {
    console.error("Failed to connect to the database:");
    console.error(error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
