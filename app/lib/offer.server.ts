import prisma from "../db.server";
import {numericVariantId} from "./personalisation";

export type PurchaseContext = {variantIds?: string[]; productIds?: string[]; subtotal?: number};

function matches(offer: any, ctx: PurchaseContext = {}) {
  if (offer.triggerMode === "ALWAYS") return true;
  const cfg = (offer.triggerConfig || {}) as any;
  if (offer.triggerMode === "CONTAINS_VARIANT") return (ctx.variantIds || []).some((id) => (cfg.variantIds || []).includes(String(id)));
  if (offer.triggerMode === "CONTAINS_PRODUCT") return (ctx.productIds || []).some((id) => (cfg.productIds || []).includes(String(id)));
  if (offer.triggerMode === "MIN_SUBTOTAL") return Number(ctx.subtotal || 0) >= Number(cfg.amount || 0);
  return false;
}

export async function getEligibleOffers(shopDomain: string, ctx: PurchaseContext = {}) {
  const offers = await prisma.offer.findMany({
    where: {shopDomain, status: "ACTIVE"}, include: {fields: {orderBy: {sortOrder: "asc"}}}, orderBy: [{priority:"asc"},{updatedAt:"desc"}], take: 20,
  });
  return offers.filter((o) => matches(o, ctx)).slice(0, 3);
}

export async function getOffer(shopDomain: string, id: string) {
  return prisma.offer.findFirst({where:{id,shopDomain}, include:{fields:{orderBy:{sortOrder:"asc"}}}});
}

export function publicOffer(offer: any) {
  const price = Number(offer.originalPrice);
  const discount = Number(offer.discountValue);
  const discounted = offer.discountType === "percentage" ? price * (1 - discount / 100) : Math.max(0, price - discount);
  return {
    id: offer.id, productTitle: offer.productTitle, variantTitle: offer.variantTitle || undefined,
    productImageURL: offer.productImageUrl || undefined, productDescription: [offer.description], currencyCode: offer.currencyCode,
    originalPrice: price.toFixed(2), discountedPrice: discounted.toFixed(2), headline: offer.headline, buttonLabel: offer.buttonLabel,
    fields: offer.fields.map((f:any)=>({id:f.id,key:f.key,type:f.type,label:f.label,placeholder:f.placeholder||undefined,helpText:f.helpText||undefined,required:f.required,minLength:f.minLength||undefined,maxLength:f.maxLength||undefined,options:f.options||undefined})),
    previewChanges: [{type:"add_variant",variantId:numericVariantId(offer.variantId),quantity:1,...(discount>0?{discount:{value:discount,valueType:offer.discountType,title:"Post-purchase offer"}}:{})}],
  };
}
