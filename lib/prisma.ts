// src/lib/prisma.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client'

declare global {
  // allow global prisma in dev to prevent multiple instances
  var __prisma__: PrismaClient | undefined;
}

const prisma: PrismaClient =
  global.__prisma__ ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__prisma__ = prisma;
}

export default prisma;
