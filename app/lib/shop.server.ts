import prisma from "../db.server";

export async function ensureShop(domain: string) {
  return prisma.shop.upsert({
    where: {domain},
    create: {domain, settings: {create: {}}},
    update: {uninstalledAt: null},
    include: {settings: true},
  });
}
