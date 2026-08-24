import {mkdir, writeFile} from "node:fs/promises";
import {dirname} from "node:path";

const files = new Map();

files.set("app/lib/checkout.server.js", String.raw`import {createHash, randomUUID} from "node:crypto";
import prisma from "../db.server";
import {changesetDiscount, discountedUnitPrice} from "./offer.server";

function gidList(values, resource) {
  const prefix = "gid://shopify/" + resource + "/";
  return Array.from(new Set((Array.isArray(values) ? values : []).map(function (value) { return String(value || ""); }).filter(function (value) { return value.startsWith(prefix); }))).slice(0, 250);
}

export function sanitizePurchaseContext(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    variantIds: gidList(source.variantIds, "ProductVariant"),
    productIds: gidList(source.productIds, "Product"),
    subtotal: Math.max(0, Math.min(10000000, Number(source.subtotal || 0))),
    countryCode: /^[A-Za-z]{2}$/.test(String(source.countryCode || "")) ? String(source.countryCode).toUpperCase() : "",
  };
}

export function acceptanceKey(shopId, referenceId, offerId) {
  return createHash("sha256").update(shopId + "\n" + referenceId + "\n" + offerId).digest("hex");
}

export function metafieldKey(acceptanceId) {
  return "acceptance_" + String(acceptanceId).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 50);
}

export function changesForOffer(offer, liveVariant, acceptance, personalisation) {
  const quantity = Math.max(1, Math.min(5, Number(offer.quantity || 1)));
  const addVariant = {
    type: "add_variant",
    variantId: liveVariant.numericId,
    quantity: quantity,
  };
  const discount = changesetDiscount(offer);
  if (discount) addVariant.discount = discount;
  const expectedAmount = discountedUnitPrice(liveVariant.price, offer.discountType, offer.discountValue) * quantity;
  const metadata = {
    version: 1,
    acceptanceId: acceptance.id,
    offerId: offer.id,
    offerName: offer.name,
    variantId: liveVariant.id,
    productTitle: liveVariant.productTitle,
    variantTitle: liveVariant.variantTitle,
    quantity: quantity,
    personalisation: personalisation,
    expectedAmount: expectedAmount.toFixed(2),
    currencyCode: liveVariant.currencyCode,
    createdAt: new Date().toISOString(),
  };
  return {
    expectedAmount: expectedAmount,
    changes: [
      addVariant,
      {
        type: "set_metafield",
        namespace: "personalised_upsell",
        key: metafieldKey(acceptance.id),
        valueType: "json_string",
        value: JSON.stringify(metadata),
      },
    ],
  };
}

export async function reserveAcceptance(data) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  const jti = randomUUID();
  return prisma.$transaction(async function (tx) {
    const existing = await tx.acceptance.findUnique({
      where: {
        shopId_referenceId_offerId: {
          shopId: data.shopId,
          referenceId: data.referenceId,
          offerId: data.offerId,
        },
      },
    });
    if (existing && ["PROCESSED", "PARTIAL"].includes(existing.status)) {
      throw new Response("This offer has already been added.", {status: 409});
    }
    if (existing && existing.status === "SIGNED" && existing.expiresAt && existing.expiresAt > now) {
      throw new Response("This offer is already being processed.", {status: 409});
    }
    const values = {
      idempotencyKey: acceptanceKey(data.shopId, data.referenceId, data.offerId),
      changesetJti: jti,
      status: "SIGNED",
      personalisation: data.personalisation,
      expectedAmount: data.expectedAmount,
      currencyCode: data.currencyCode,
      signedAt: now,
      expiresAt: expiresAt,
    };
    const acceptance = existing
      ? await tx.acceptance.update({where: {id: existing.id}, data: values})
      : await tx.acceptance.create({
          data: {
            ...values,
            shopId: data.shopId,
            offerId: data.offerId,
            referenceId: data.referenceId,
          },
        });
    return {acceptance: acceptance, jti: jti};
  }, {isolationLevel: "Serializable"});
}
`);

files.set("app/routes/api.offer.jsx", String.raw`import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {ensureShop, normalizeShop} from "../lib/shop.server";
import {enforceRateLimit, signOfferToken, stableContextHash} from "../lib/security.server";
import {isOfferEligible, recordEvent, serializeOffer} from "../lib/offer.server";
import {loadVariantForShop} from "../lib/shopify-product.server";
import {jsonResponse, publicError, readJson} from "../lib/responses.server";
import {sanitizePurchaseContext} from "../lib/checkout.server";

export async function action({request}) {
  let cors = function (response) { return response; };
  try {
    const context = await authenticate.public.checkout(request);
    cors = context.cors;
    const shopDomain = normalizeShop(context.sessionToken.dest);
    const shop = await ensureShop(shopDomain);
    await enforceRateLimit(shop.id + ":offer", 40, 60);
    const body = await readJson(request, 32768);
    const referenceId = String(body.referenceId || "").slice(0, 200);
    if (!referenceId) throw new Response("Missing purchase reference", {status: 400});
    const purchase = sanitizePurchaseContext(body.purchase);
    const offers = await prisma.offer.findMany({
      where: {shopId: shop.id, status: "ACTIVE"},
      include: {fields: {orderBy: {sortOrder: "asc"}}},
      orderBy: [{priority: "desc"}, {createdAt: "asc"}],
      take: 20,
    });
    for (const offer of offers) {
      if (!isOfferEligible(offer, purchase)) continue;
      let liveVariant;
      try {
        liveVariant = await loadVariantForShop(shopDomain, offer.productVariantId);
      } catch {
        continue;
      }
      await recordEvent({shopId: shop.id, offerId: offer.id, referenceId: referenceId, type: "VIEW", detail: {countryCode: purchase.countryCode}});
      const contextHash = stableContextHash(purchase);
      const offerToken = await signOfferToken({shop: shopDomain, offerId: offer.id, referenceId: referenceId, contextHash: contextHash});
      return cors(jsonResponse({offer: serializeOffer(offer, liveVariant), offerToken: offerToken}));
    }
    return cors(jsonResponse({offer: null}));
  } catch (error) {
    return cors(publicError(error));
  }
}

export async function loader() {
  return new Response("Method not allowed", {status: 405});
}
`);

files.set("app/routes/api.sign-changeset.jsx", String.raw`import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {ensureShop, normalizeShop} from "../lib/shop.server";
import {enforceRateLimit, signShopifyChangeset, verifyOfferToken} from "../lib/security.server";
import {isOfferEligible, discountedUnitPrice} from "../lib/offer.server";
import {loadVariantForShop} from "../lib/shopify-product.server";
import {validatePersonalisation} from "../lib/personalisation";
import {changesForOffer, reserveAcceptance} from "../lib/checkout.server";
import {jsonResponse, publicError, readJson} from "../lib/responses.server";

export async function action({request}) {
  let cors = function (response) { return response; };
  try {
    const context = await authenticate.public.checkout(request);
    cors = context.cors;
    const shopDomain = normalizeShop(context.sessionToken.dest);
    const shop = await ensureShop(shopDomain);
    await enforceRateLimit(shop.id + ":sign", 12, 60);
    const body = await readJson(request, 32768);
    const referenceId = String(body.referenceId || "").slice(0, 200);
    const tokenPayload = await verifyOfferToken(body.offerToken);
    if (tokenPayload.shop !== shopDomain || tokenPayload.sub !== referenceId) {
      throw new Response("Offer token mismatch", {status: 403});
    }
    const offer = await prisma.offer.findFirst({
      where: {id: String(tokenPayload.offerId), shopId: shop.id},
      include: {fields: {orderBy: {sortOrder: "asc"}}},
    });
    if (!offer || !isOfferEligible(offer, {variantIds: [], productIds: [], subtotal: 0, countryCode: ""})) {
      throw new Response("Offer is no longer available", {status: 409});
    }
    const liveVariant = await loadVariantForShop(shopDomain, offer.productVariantId);
    const personalisation = validatePersonalisation(offer.fields, body.personalisation);
    const quantity = Math.max(1, Math.min(5, Number(offer.quantity || 1)));
    const expectedAmount = discountedUnitPrice(liveVariant.price, offer.discountType, offer.discountValue) * quantity;
    const reservation = await reserveAcceptance({
      shopId: shop.id,
      offerId: offer.id,
      referenceId: referenceId,
      personalisation: personalisation,
      expectedAmount: expectedAmount,
      currencyCode: liveVariant.currencyCode,
    });
    const changeData = changesForOffer(offer, liveVariant, reservation.acceptance, personalisation);
    const signedToken = await signShopifyChangeset(referenceId, changeData.changes, reservation.jti);
    return cors(jsonResponse({token: signedToken, acceptanceId: reservation.acceptance.id}));
  } catch (error) {
    return cors(publicError(error));
  }
}

export async function loader() {
  return new Response("Method not allowed", {status: 405});
}
`);

files.set("app/routes/api.acceptance-result.jsx", String.raw`import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {ensureShop, normalizeShop} from "../lib/shop.server";
import {recordEvent} from "../lib/offer.server";
import {jsonResponse, publicError, readJson} from "../lib/responses.server";

export async function action({request}) {
  let cors = function (response) { return response; };
  try {
    const context = await authenticate.public.checkout(request);
    cors = context.cors;
    const shop = await ensureShop(normalizeShop(context.sessionToken.dest));
    const body = await readJson(request, 8192);
    const acceptance = await prisma.acceptance.findFirst({where: {id: String(body.acceptanceId || ""), shopId: shop.id}});
    if (!acceptance) throw new Response("Not found", {status: 404});
    const result = String(body.result || "unprocessed");
    const status = result === "processed" ? "PROCESSED" : result === "partially_processed" ? "PARTIAL" : "FAILED";
    await prisma.acceptance.update({
      where: {id: acceptance.id},
      data: {status: status, processedAt: status === "FAILED" ? null : new Date(), expiresAt: null},
    });
    await recordEvent({
      shopId: shop.id,
      offerId: acceptance.offerId,
      referenceId: acceptance.referenceId,
      type: status === "FAILED" ? "ERROR" : "ACCEPT",
      detail: {changesetResult: result},
    });
    return cors(jsonResponse({ok: true}));
  } catch (error) {
    return cors(publicError(error));
  }
}
`);

files.set("app/routes/api.decline.jsx", String.raw`import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {ensureShop, normalizeShop} from "../lib/shop.server";
import {recordEvent} from "../lib/offer.server";
import {verifyOfferToken} from "../lib/security.server";
import {jsonResponse, publicError, readJson} from "../lib/responses.server";

export async function action({request}) {
  let cors = function (response) { return response; };
  try {
    const context = await authenticate.public.checkout(request);
    cors = context.cors;
    const shopDomain = normalizeShop(context.sessionToken.dest);
    const shop = await ensureShop(shopDomain);
    const body = await readJson(request, 8192);
    const payload = await verifyOfferToken(body.offerToken);
    if (payload.shop !== shopDomain || payload.sub !== String(body.referenceId || "")) throw new Response("Forbidden", {status: 403});
    const offer = await prisma.offer.findFirst({where: {id: String(payload.offerId), shopId: shop.id}});
    if (offer) await recordEvent({shopId: shop.id, offerId: offer.id, referenceId: String(body.referenceId), type: "DECLINE", detail: {}});
    return cors(jsonResponse({ok: true}));
  } catch (error) {
    return cors(publicError(error));
  }
}
`);

files.set("app/routes/api.retention.jsx", String.raw`import {timingSafeEqual} from "node:crypto";
import prisma from "../db.server";
import {jsonResponse} from "../lib/responses.server";

function authorised(request) {
  const expected = Buffer.from(process.env.CRON_SECRET || "");
  const supplied = Buffer.from(String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  return expected.length >= 32 && expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export async function action({request}) {
  if (!authorised(request)) return jsonResponse({error: "Unauthorized"}, {status: 401});
  const now = new Date();
  const shops = await prisma.shop.findMany({select: {id: true, retentionDays: true}});
  let purged = 0;
  for (const shop of shops) {
    const cutoff = new Date(now.getTime() - shop.retentionDays * 86400000);
    const result = await prisma.acceptance.updateMany({
      where: {shopId: shop.id, createdAt: {lt: cutoff}},
      data: {personalisation: {purged: true}, customerId: null, customerEmailHash: null},
    });
    purged += result.count;
    await prisma.acceptance.deleteMany({where: {shopId: shop.id, status: {in: ["PENDING", "FAILED"]}, createdAt: {lt: cutoff}}});
  }
  await Promise.all([
    prisma.rateLimitBucket.deleteMany({where: {resetAt: {lt: now}}}),
    prisma.webhookReceipt.deleteMany({where: {receivedAt: {lt: new Date(now.getTime() - 30 * 86400000)}}}),
    prisma.privacyRequest.deleteMany({where: {expiresAt: {lt: now}}}),
  ]);
  return jsonResponse({ok: true, purged: purged});
}

export async function loader() {
  return new Response("Method not allowed", {status: 405});
}
`);

files.set("app/lib/order-reconciliation.server.js", String.raw`import prisma from "../db.server";
import {unauthenticated} from "../shopify.server";
import {hashCustomerEmail} from "./security.server";

const ORDER_QUERY = "#graphql\nquery PersonalisedOrder($id: ID!) {\n  order(id: $id) {\n    id\n    name\n    metafields(first: 100, namespace: \"personalised_upsell\") {\n      nodes { key value type }\n    }\n  }\n}";

export async function reconcileOrder(shop, shopRecord, payload) {
  const numericOrderId = payload.id ? String(payload.id) : "";
  const orderId = payload.admin_graphql_api_id || (numericOrderId ? "gid://shopify/Order/" + numericOrderId : "");
  if (!orderId) throw new Error("Order webhook did not contain an order ID.");
  const context = await unauthenticated.admin(shop);
  const response = await context.admin.graphql(ORDER_QUERY, {variables: {id: orderId}});
  const body = await response.json();
  if (body.errors && body.errors.length) throw new Error("Shopify order reconciliation query failed.");
  const order = body.data && body.data.order;
  if (!order) return 0;
  const customerId = payload.customer && (payload.customer.admin_graphql_api_id || payload.customer.id)
    ? String(payload.customer.admin_graphql_api_id || payload.customer.id)
    : null;
  const customerEmailHash = hashCustomerEmail(payload.email || (payload.customer && payload.customer.email));
  let reconciled = 0;
  for (const metafield of order.metafields.nodes || []) {
    let data;
    try {
      data = JSON.parse(metafield.value);
    } catch {
      continue;
    }
    if (!data || data.version !== 1 || !data.acceptanceId) continue;
    const acceptance = await prisma.acceptance.findFirst({where: {id: String(data.acceptanceId), shopId: shopRecord.id}});
    if (!acceptance) continue;
    await prisma.acceptance.update({
      where: {id: acceptance.id},
      data: {
        orderId: order.id,
        orderName: order.name,
        customerId: customerId,
        customerEmailHash: customerEmailHash,
        personalisation: data.personalisation || acceptance.personalisation,
        expectedAmount: Number(data.expectedAmount || acceptance.expectedAmount),
        currencyCode: data.currencyCode || acceptance.currencyCode,
        status: acceptance.status === "FAILED" ? "PARTIAL" : acceptance.status === "PENDING" || acceptance.status === "SIGNED" ? "PROCESSED" : acceptance.status,
        processedAt: acceptance.processedAt || new Date(),
        expiresAt: null,
      },
    });
    reconciled += 1;
  }
  return reconciled;
}
`);

files.set("app/routes/webhooks.orders.updated.jsx", String.raw`import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {ensureShop} from "../lib/shop.server";
import {recordWebhook} from "../lib/security.server";
import {reconcileOrder} from "../lib/order-reconciliation.server";

export async function action({request}) {
  const {payload, topic, shop} = await authenticate.webhook(request);
  const shopRecord = await ensureShop(shop);
  const shouldProcess = await recordWebhook(request, shopRecord.id, topic);
  if (!shouldProcess) return new Response();
  try {
    await reconcileOrder(shop, shopRecord, payload);
    return new Response();
  } catch (error) {
    const webhookId = request.headers.get("x-shopify-webhook-id");
    if (webhookId) await prisma.webhookReceipt.deleteMany({where: {id: webhookId}});
    console.error(error);
    return new Response("Webhook processing failed", {status: 500});
  }
}
`);

files.set("app/routes/webhooks.app.uninstalled.jsx", String.raw`import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {ensureShop} from "../lib/shop.server";
import {recordWebhook} from "../lib/security.server";

export async function action({request}) {
  const {topic, shop} = await authenticate.webhook(request);
  const shopRecord = await ensureShop(shop);
  if (!await recordWebhook(request, shopRecord.id, topic)) return new Response();
  await prisma.$transaction([
    prisma.shop.update({where: {id: shopRecord.id}, data: {uninstalledAt: new Date()}}),
    prisma.session.deleteMany({where: {shop: shop}}),
  ]);
  return new Response();
}
`);

files.set("app/routes/webhooks.app.scopes_update.jsx", String.raw`import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {ensureShop} from "../lib/shop.server";
import {recordWebhook} from "../lib/security.server";

export async function action({request}) {
  const {payload, session, topic, shop} = await authenticate.webhook(request);
  const shopRecord = await ensureShop(shop);
  if (!await recordWebhook(request, shopRecord.id, topic)) return new Response();
  if (session) {
    const current = Array.isArray(payload.current) ? payload.current.join(",") : String(payload.current || "");
    await prisma.session.updateMany({where: {id: session.id}, data: {scope: current}});
  }
  return new Response();
}
`);

files.set("app/routes/webhooks.customers.data_request.jsx", String.raw`import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {ensureShop} from "../lib/shop.server";
import {hashCustomerEmail, recordWebhook} from "../lib/security.server";

export async function action({request}) {
  const {payload, topic, shop} = await authenticate.webhook(request);
  const shopRecord = await ensureShop(shop);
  if (!await recordWebhook(request, shopRecord.id, topic)) return new Response();
  const customerId = payload.customer && payload.customer.id ? String(payload.customer.id) : null;
  const customerEmailHash = hashCustomerEmail(payload.customer && payload.customer.email);
  const conditions = [];
  if (customerId) conditions.push({customerId: customerId});
  if (customerEmailHash) conditions.push({customerEmailHash: customerEmailHash});
  const records = conditions.length ? await prisma.acceptance.findMany({
    where: {shopId: shopRecord.id, OR: conditions},
    select: {orderId: true, orderName: true, personalisation: true, createdAt: true, processedAt: true},
  }) : [];
  await prisma.privacyRequest.create({
    data: {
      shopId: shopRecord.id,
      shopDomain: shop,
      requestType: "DATA_REQUEST",
      status: "COMPLETE",
      customerId: customerId,
      customerEmailHash: customerEmailHash,
      result: {records: records.map(function (record) { return {...record, createdAt: record.createdAt.toISOString(), processedAt: record.processedAt ? record.processedAt.toISOString() : null}; })},
      expiresAt: new Date(Date.now() + 30 * 86400000),
      completedAt: new Date(),
    },
  });
  return new Response();
}
`);

files.set("app/routes/webhooks.customers.redact.jsx", String.raw`import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {ensureShop} from "../lib/shop.server";
import {hashCustomerEmail, recordWebhook} from "../lib/security.server";

export async function action({request}) {
  const {payload, topic, shop} = await authenticate.webhook(request);
  const shopRecord = await ensureShop(shop);
  if (!await recordWebhook(request, shopRecord.id, topic)) return new Response();
  const customerId = payload.customer && payload.customer.id ? String(payload.customer.id) : null;
  const customerEmailHash = hashCustomerEmail(payload.customer && payload.customer.email);
  const conditions = [];
  if (customerId) conditions.push({customerId: customerId});
  if (customerEmailHash) conditions.push({customerEmailHash: customerEmailHash});
  let count = 0;
  if (conditions.length) {
    const result = await prisma.acceptance.updateMany({
      where: {shopId: shopRecord.id, OR: conditions},
      data: {status: "REDACTED", personalisation: {redacted: true}, customerId: null, customerEmailHash: null},
    });
    count = result.count;
  }
  await prisma.privacyRequest.create({
    data: {
      shopId: shopRecord.id,
      shopDomain: shop,
      requestType: "CUSTOMER_REDACT",
      status: "COMPLETE",
      customerId: customerId,
      customerEmailHash: customerEmailHash,
      result: {redactedRecords: count},
      expiresAt: new Date(Date.now() + 30 * 86400000),
      completedAt: new Date(),
    },
  });
  return new Response();
}
`);

files.set("app/routes/webhooks.shop.redact.jsx", String.raw`import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {normalizeShop} from "../lib/shop.server";

export async function action({request}) {
  const {shop} = await authenticate.webhook(request);
  const domain = normalizeShop(shop);
  await prisma.$transaction([
    prisma.session.deleteMany({where: {shop: domain}}),
    prisma.shop.deleteMany({where: {domain: domain}}),
  ]);
  return new Response();
}
`);

files.set("extensions/personalised-post-purchase/package.json", String.raw`{
  "name": "personalised-post-purchase-extension",
  "version": "1.0.0",
  "private": true,
  "main": "src/index.jsx",
  "license": "UNLICENSED",
  "dependencies": {
    "@shopify/post-purchase-ui-extensions-react": "0.13.2",
    "react": "17.0.2"
  }
}
`);

files.set("extensions/personalised-post-purchase/shopify.extension.toml", String.raw`name = "Personalised post-purchase offer"
type = "checkout_post_purchase"
`);

files.set("extensions/personalised-post-purchase/src/app-url.js", String.raw`export const APP_URL = "https://REPLACE_WITH_PRODUCTION_DOMAIN";
`);

files.set("extensions/personalised-post-purchase/src/index.jsx", String.raw`import React, {useEffect, useState} from "react";
import {
  extend,
  render,
  useExtensionInput,
  BlockStack,
  Button,
  CalloutBanner,
  Checkbox,
  Heading,
  Image,
  Select,
  Separator,
  TextBlock,
  TextField,
} from "@shopify/post-purchase-ui-extensions-react";
import {APP_URL} from "./app-url";

function purchaseContext(input) {
  const purchase = input && input.initialPurchase ? input.initialPurchase : {};
  const items = Array.isArray(purchase.lineItems) ? purchase.lineItems : [];
  return {
    variantIds: items.map(function (item) { return String(item.variant && item.variant.id || item.variantId || ""); }).filter(Boolean),
    productIds: items.map(function (item) { return String(item.product && item.product.id || item.productId || ""); }).filter(Boolean),
    subtotal: Number(purchase.subtotalPriceSet && purchase.subtotalPriceSet.presentmentMoney && purchase.subtotalPriceSet.presentmentMoney.amount || 0),
    countryCode: String(purchase.shippingAddress && purchase.shippingAddress.countryCode || ""),
  };
}

async function requestOffer(inputData) {
  const response = await fetch(APP_URL + "/api/offer", {
    method: "POST",
    headers: {Authorization: "Bearer " + inputData.token, "Content-Type": "application/json"},
    body: JSON.stringify({
      referenceId: inputData.initialPurchase.referenceId,
      purchase: purchaseContext(inputData),
    }),
  });
  if (!response.ok) return null;
  return response.json();
}

extend("Checkout::PostPurchase::ShouldRender", async function ({inputData, storage}) {
  try {
    const data = await requestOffer(inputData);
    if (!data || !data.offer) return {render: false};
    await storage.update(data);
    return {render: true};
  } catch {
    return {render: false};
  }
});

render("Checkout::PostPurchase::Render", function () {
  return <PostPurchaseOffer />;
});

function PostPurchaseOffer() {
  const extension = useExtensionInput();
  const {storage, inputData, calculateChangeset, applyChangeset, done} = extension;
  const [data, setData] = useState(storage.initialData || null);
  const [values, setValues] = useState({});
  const [calculated, setCalculated] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(function () {
    if (data && data.offer) return undefined;
    let active = true;
    requestOffer(inputData).then(function (result) { if (active) setData(result); }).catch(function () { if (active) setData(null); });
    return function () { active = false; };
  }, []);

  const offer = data && data.offer;

  useEffect(function () {
    if (!offer) return undefined;
    let active = true;
    calculateChangeset({changes: offer.previewChanges})
      .then(function (result) { if (active) setCalculated(result.calculatedPurchase); })
      .catch(function () { if (active) setCalculated(null); });
    return function () { active = false; };
  }, [offer && offer.id]);

  if (!data) {
    return <BlockStack spacing="loose"><TextBlock>Loading your optional offer…</TextBlock><Button onPress={done}>Continue to order</Button></BlockStack>;
  }
  if (!offer) {
    return <BlockStack spacing="loose"><TextBlock>This offer is no longer available. Your original order is confirmed.</TextBlock><Button onPress={done}>View my order</Button></BlockStack>;
  }

  const calculatedMoney = calculated && calculated.totalOutstandingSet && calculated.totalOutstandingSet.presentmentMoney;
  const total = calculatedMoney ? calculatedMoney.amount : offer.discountedPrice;
  const currency = calculatedMoney ? calculatedMoney.currencyCode : offer.currencyCode;

  function setValue(key, value) {
    setValues(function (current) { return {...current, [key]: value}; });
    setError("");
  }

  function validate() {
    for (const field of offer.fields) {
      if (field.type === "CHECKBOX") {
        if (field.required && !values[field.key]) throw new Error(field.label + " is required.");
        continue;
      }
      const value = String(values[field.key] || "").normalize("NFC").trim();
      const length = Array.from(value).length;
      if (field.required && !value) throw new Error(field.label + " is required.");
      if (field.minLength !== null && field.minLength !== undefined && value && length < field.minLength) throw new Error(field.label + " is too short.");
      if (field.maxLength !== null && field.maxLength !== undefined && length > field.maxLength) throw new Error(field.label + " is too long.");
      if (field.type === "SELECT" && value && !field.options.includes(value)) throw new Error(field.label + " contains an invalid selection.");
    }
  }

  async function accept() {
    if (loading) return;
    setLoading(true);
    setError("");
    let acceptanceId = null;
    try {
      validate();
      const response = await fetch(APP_URL + "/api/sign-changeset", {
        method: "POST",
        headers: {Authorization: "Bearer " + inputData.token, "Content-Type": "application/json"},
        body: JSON.stringify({
          referenceId: inputData.initialPurchase.referenceId,
          offerToken: data.offerToken,
          personalisation: values,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The offer could not be prepared.");
      acceptanceId = body.acceptanceId;
      const result = await applyChangeset(body.token);
      await fetch(APP_URL + "/api/acceptance-result", {
        method: "POST",
        headers: {Authorization: "Bearer " + inputData.token, "Content-Type": "application/json"},
        body: JSON.stringify({acceptanceId: acceptanceId, result: result.status}),
      }).catch(function () {});
      if (result.status !== "processed" && result.status !== "partially_processed") {
        throw new Error(result.errors && result.errors[0] && result.errors[0].message || "The offer was not added.");
      }
      await done();
    } catch (caught) {
      setError(caught && caught.message || "We could not add this item. Your original order is still confirmed.");
      setLoading(false);
    }
  }

  async function decline() {
    fetch(APP_URL + "/api/decline", {
      method: "POST",
      headers: {Authorization: "Bearer " + inputData.token, "Content-Type": "application/json"},
      body: JSON.stringify({referenceId: inputData.initialPurchase.referenceId, offerToken: data.offerToken}),
    }).catch(function () {});
    await done();
  }

  return (
    <BlockStack spacing="loose">
      <CalloutBanner title={offer.headline}><TextBlock>{offer.description || "Personalise it now and add it to your confirmed order."}</TextBlock></CalloutBanner>
      {offer.productImageUrl ? <Image source={offer.productImageUrl} /> : null}
      <Heading>{offer.productTitle}{offer.variantTitle ? " — " + offer.variantTitle : ""}</Heading>
      <TextBlock>{offer.currencyCode} {offer.originalPrice} before offer · {offer.currencyCode} {offer.discountedPrice} after offer</TextBlock>
      {offer.fields.map(function (field) { return <PersonalisationField key={field.key} field={field} value={values[field.key]} onChange={function (value) { setValue(field.key, value); }} />; })}
      {error ? <CalloutBanner title="We could not add the optional item"><TextBlock>{error}</TextBlock><TextBlock>Your original order is still confirmed and has not been changed.</TextBlock></CalloutBanner> : null}
      <Separator />
      <TextBlock>Total to add: {currency} {total}</TextBlock>
      <Button onPress={accept} loading={loading}>Add personalised item — {currency} {total}</Button>
      <Button subdued onPress={decline} disabled={loading}>No thanks, view my order</Button>
    </BlockStack>
  );
}

function PersonalisationField({field, value, onChange}) {
  if (field.type === "SELECT") {
    const options = [{label: "Select an option", value: ""}].concat(field.options.map(function (option) { return {label: option, value: option}; }));
    return <Select label={field.label} value={String(value || "")} options={options} onChange={onChange} />;
  }
  if (field.type === "CHECKBOX") {
    return <Checkbox checked={Boolean(value)} onChange={onChange}>{field.label}</Checkbox>;
  }
  return <BlockStack spacing="tight"><TextField label={field.label} value={String(value || "")} placeholder={field.placeholder || ""} required={field.required} onChange={onChange} />{field.helpText ? <TextBlock subdued>{field.helpText}</TextBlock> : null}{value ? <TextBlock>Preview: {String(value)}</TextBlock> : null}</BlockStack>;
}
`);

files.set("tests/personalisation.test.mjs", String.raw`import test from "node:test";
import assert from "node:assert/strict";
import {normalizeFieldKey, validateFieldDefinitions, validatePersonalisation} from "../app/lib/personalisation.js";

const fields = validateFieldDefinitions([
  {label: "Name to print", type: "SHORT_TEXT", required: true, minLength: 1, maxLength: 20},
  {label: "Font", type: "SELECT", required: true, options: ["Serif", "Script"]},
  {label: "Gift box", type: "CHECKBOX", required: false},
]);

test("normalises field keys", function () {
  assert.equal(normalizeFieldKey(" Name to Print! "), "name_to_print");
});

test("validates and normalises customer values", function () {
  const result = validatePersonalisation(fields, {name_to_print: "  Amélie  ", font: "Script", gift_box: true});
  assert.equal(result.name_to_print, "Amélie");
  assert.equal(result.font, "Script");
  assert.equal(result.gift_box, true);
});

test("rejects a missing required value", function () {
  assert.throws(function () { validatePersonalisation(fields, {font: "Serif"}); }, /Name to print is required/);
});

test("rejects an unconfigured select option", function () {
  assert.throws(function () { validatePersonalisation(fields, {name_to_print: "Sam", font: "Comic"}); }, /invalid selection/);
});
`);

files.set("tests/offers.test.mjs", String.raw`import test from "node:test";
import assert from "node:assert/strict";
import {discountedUnitPrice, isOfferEligible} from "../app/lib/offer.server.js";

test("calculates percentage and fixed discounts safely", function () {
  assert.equal(discountedUnitPrice(20, "PERCENTAGE", 25), 15);
  assert.equal(discountedUnitPrice(20, "FIXED", 4), 16);
  assert.equal(discountedUnitPrice(20, "PERCENTAGE", 200), 0);
});

test("applies targeting and avoids offering an item already purchased", function () {
  const offer = {
    status: "ACTIVE",
    productVariantId: "gid://shopify/ProductVariant/3",
    rules: {minimumSubtotal: 30, allowedCountries: ["GB"], triggerProductIds: ["gid://shopify/Product/1"]},
  };
  assert.equal(isOfferEligible(offer, {subtotal: 50, countryCode: "GB", productIds: ["gid://shopify/Product/1"], variantIds: ["gid://shopify/ProductVariant/2"]}), true);
  assert.equal(isOfferEligible(offer, {subtotal: 50, countryCode: "GB", productIds: ["gid://shopify/Product/1"], variantIds: ["gid://shopify/ProductVariant/3"]}), false);
  assert.equal(isOfferEligible(offer, {subtotal: 20, countryCode: "GB", productIds: ["gid://shopify/Product/1"], variantIds: []}), false);
});
`);

files.set(".github/workflows/ci.yml", String.raw`name: Production gates

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: production-gates-${{ github.ref }}
  cancel-in-progress: true

jobs:
  validate:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: personalised_upsell_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres -d personalised_upsell_test"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      NODE_ENV: test
      SHOPIFY_API_KEY: ci_key
      SHOPIFY_API_SECRET: ci_secret_that_is_long_enough_for_tests
      SHOPIFY_APP_URL: https://ci.example.com
      SCOPES: read_products,read_orders
      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/personalised_upsell_test?schema=public
      CRON_SECRET: ci_cron_secret_that_is_at_least_32_chars
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22.12.0
          cache: npm
      - run: npm ci
      - run: npx prisma generate
      - run: npx prisma migrate deploy
      - run: npm run validate
      - run: npm audit --omit=dev --audit-level=high
      - run: docker build -t personalised-post-purchase:${{ github.sha }} .
`);

files.set(".github/dependabot.yml", String.raw`version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: monthly
`);

files.set("README.md", String.raw`# Personalised Post-Purchase Upsell

A multi-tenant Shopify app that lets merchants offer an optional personalised product after payment. Customers can enter a name, message, dropdown choice or checkbox option before accepting the additional item.

## Included

- Shopify OAuth and database-backed session storage
- Embedded merchant dashboard and multi-offer editor
- Shopify product and variant picker
- Server-verified catalog pricing, inventory and product status
- Percentage, fixed or no discount
- Product, variant, subtotal, country and schedule targeting
- One to five personalisation fields
- Post-purchase offer extension with calculated totals
- Short-lived server-signed changesets
- Replay and duplicate acceptance protection
- Order metafield reconciliation
- Searchable production queue and production statuses
- App-owned conversion and revenue analytics
- Verified uninstall, scope, order and privacy webhooks
- Customer data export, customer redaction and shop redaction
- Configurable data retention and authenticated retention job
- PostgreSQL migrations, non-root Docker image, health check, CI and dependency updates

## Local setup

1. Install Node 22.12 and Docker.
2. Copy .env.example to .env and add a Shopify Partner app key and secret.
3. Run docker compose up -d postgres.
4. Run npm ci.
5. Run npm run setup.
6. Run shopify app config link and select the Partner app.
7. Run npm run dev and install the app on a Shopify development store.

## Production deployment

1. Provision an HTTPS application domain and managed PostgreSQL database with automated backups and point-in-time recovery.
2. Set every variable listed in .env.example. Use a random CRON_SECRET of at least 32 characters.
3. Replace the placeholder production domain in shopify.app.toml or allow Shopify CLI to update it during configuration.
4. Run npm ci and npm run validate.
5. Run npm run deploy to upload the extension and app configuration to Shopify.
6. Deploy the Docker image to a platform that supports health checks, rolling deploys and secret management.
7. Schedule a daily POST request to /api/retention with Authorization: Bearer followed by CRON_SECRET.
8. Test install, uninstall, reinstall, declined offer, accepted offer, partial processing, order reconciliation and all privacy webhooks on a development store.
9. Complete Shopify review requirements, protected customer data review where applicable, and post-purchase production access before serving live checkouts.

## Release gate

The release is accepted only when all of these succeed from a clean checkout:

    npm ci
    npx prisma migrate deploy
    npm run validate
    npm audit --omit=dev --audit-level=high
    docker build -t personalised-post-purchase .

## External launch gates

Source code alone cannot grant Shopify platform access or make a service operational. A live release still requires Partner credentials, an approved distribution configuration, a real HTTPS deployment, a managed database, monitoring, backups, development-store checkout evidence and Shopify access for the post-purchase surface.

## Privacy

See PRIVACY.md. Personalisation is merchant-controlled order production data. The app hashes customer email addresses, stores only the identifiers required for redaction, and purges personalisation according to the merchant retention setting.
`);

files.set("PRIVACY.md", String.raw`# Privacy and data handling

The app stores merchant configuration, post-purchase acceptance state, order identifiers and the personalisation values entered by a customer. It does not store payment credentials.

Customer email addresses are never stored in plaintext. When an email is available from a verified Shopify webhook, the app stores only a SHA-256 hash so that later privacy requests can be matched.

The app implements the Shopify customers/data_request, customers/redact and shop/redact compliance webhooks. Data request results are retained for 30 days. Customer redaction replaces personalisation with a redaction marker and removes customer references. Shop redaction deletes sessions and all shop-owned application data through cascading database relations.

Merchants select a retention period between 30 and 730 days. The authenticated retention job purges personalisation and customer references after that period.

Production operators must restrict database access, encrypt storage and backups, use TLS, rotate secrets, review audit logs and document lawful retention requirements with merchants.
`);

files.set("SECURITY.md", String.raw`# Security policy

Report security issues privately to the repository owner. Do not open a public issue containing credentials, customer data or exploit details.

The application uses Shopify-verified admin and checkout session tokens, server-side catalog verification, tenant-scoped database queries, short-lived signed offer and changeset tokens, serializable acceptance reservation, database rate limiting, verified webhook authentication and webhook deduplication.

Production operators must use a managed secrets service, HTTPS only, a private managed PostgreSQL service, automated backups, monitoring and alerting. Rotate the Shopify secret and CRON_SECRET after suspected exposure. Never commit .env files or database exports.

The CI release gate blocks high-severity production dependency advisories, migration failures, lint failures, unit test failures, application build failures, extension bundle failures and Docker build failures.
`);

files.set("PRODUCTION_READINESS.md", String.raw`# Production readiness record

## Code gates

- Clean dependency installation from package-lock.json
- Prisma schema validation and migration deployment against PostgreSQL 16
- React Router route type generation
- Zero-warning lint
- Unit tests for validation, targeting and discount logic
- Server application production build
- Post-purchase extension production bundle
- High-severity production dependency audit
- Non-root Docker image build and health endpoint

## Security and isolation

- OAuth sessions are persisted in PostgreSQL
- Every merchant write is scoped to the authenticated shop
- Public checkout routes require a verified Shopify checkout token
- Product price, product status and inventory are checked on the server
- Changesets are signed for one checkout reference and expire after five minutes
- Concurrent duplicate acceptance signing is blocked in a serializable transaction
- Webhooks are authenticated and deduplicated
- Personalisation is stored in an order metafield and reconciled by order webhook
- Compliance webhooks export, redact and delete application data
- Retention removes personalisation and customer references

## Operational gates not represented by source code

- Shopify Partner app credentials and distribution configuration
- Live HTTPS hosting, managed PostgreSQL, backups and recovery test
- Error monitoring, uptime alerts, logs and incident response ownership
- Shopify post-purchase production access
- Protected customer data approval where required
- Development-store and live-payment end-to-end evidence
- Shopify App Review for public distribution

The application must not be labelled operationally production ready until the code gates are green and every applicable operational gate is complete.
`);

files.set("LICENSE", String.raw`MIT License

Copyright (c) 2026 sim0n20

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED AS IS, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`);

for (const [path, content] of files) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, content, "utf8");
}
