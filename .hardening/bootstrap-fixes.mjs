import {mkdir, writeFile} from "node:fs/promises";
import {dirname} from "node:path";

const files = new Map();

files.set(".eslintrc.cjs", String.raw`module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: {jsx: true},
  },
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  ignorePatterns: [
    "build/",
    ".react-router/",
    ".tmp/",
    "node_modules/",
    "extensions/personalised-post-purchase/src/app-url.js",
  ],
  extends: ["eslint:recommended"],
  overrides: [
    {
      files: ["**/*.{js,jsx}"],
      plugins: ["react", "react-hooks", "jsx-a11y", "import"],
      extends: [
        "plugin:react/recommended",
        "plugin:react/jsx-runtime",
        "plugin:react-hooks/recommended",
        "plugin:jsx-a11y/recommended",
      ],
      settings: {
        react: {version: "detect"},
      },
      rules: {
        "react/prop-types": "off",
        "react-hooks/exhaustive-deps": "off",
        "no-console": ["error", {allow: ["warn", "error"]}],
        "import/no-unresolved": "off",
      },
    },
  ],
  globals: {
    shopify: "readonly",
  },
};
`);

files.set("app/lib/responses.server.js", String.raw`export function jsonResponse(body, init) {
  const options = init || {};
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), {
    status: options.status || 200,
    headers: headers,
  });
}

export async function readJson(request, maximumBytes) {
  const limit = maximumBytes || 32768;
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > limit) throw new Response("Payload too large", {status: 413});
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > limit) {
    throw new Response("Payload too large", {status: 413});
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Response("Invalid JSON", {status: 400});
  }
}

function responseMessage(status) {
  if (status === 400) return "The request is invalid.";
  if (status === 401) return "Authentication is required.";
  if (status === 403) return "The request is not permitted.";
  if (status === 404) return "The requested record was not found.";
  if (status === 409) return "This optional offer is already being processed or is no longer available.";
  if (status === 413) return "The request is too large.";
  if (status === 429) return "Too many requests. Please try again shortly.";
  return "The request could not be completed.";
}

export function publicError(error) {
  if (error instanceof Response) {
    return jsonResponse({error: responseMessage(error.status)}, {status: error.status, headers: error.headers});
  }
  console.error(error);
  return jsonResponse({error: "The request could not be completed."}, {status: 500});
}
`);

files.set("app/lib/shopify-product.server.js", String.raw`import {unauthenticated} from "../shopify.server";

const VARIANT_QUERY = "#graphql\nquery UpsellVariant($id: ID!) {\n  productVariant(id: $id) {\n    id\n    title\n    price\n    inventoryQuantity\n    inventoryPolicy\n    inventoryItem { tracked }\n    product {\n      id\n      title\n      status\n      featuredMedia {\n        preview {\n          image { url }\n        }\n      }\n    }\n  }\n  shop { currencyCode }\n}";

function numericId(gid) {
  const match = String(gid || "").match(/(\d+)$/);
  if (!match) throw new Error("The Shopify variant ID is invalid.");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) throw new Error("The Shopify variant ID cannot be represented safely.");
  return value;
}

export async function loadVariant(admin, variantId) {
  if (!String(variantId || "").startsWith("gid://shopify/ProductVariant/")) {
    throw new Error("Choose a Shopify product variant.");
  }
  const response = await admin.graphql(VARIANT_QUERY, {variables: {id: variantId}});
  const body = await response.json();
  if (body.errors && body.errors.length) throw new Error("Shopify could not verify the product variant.");
  const variant = body.data && body.data.productVariant;
  if (!variant || !variant.product) throw new Error("The selected product variant no longer exists.");
  if (variant.product.status !== "ACTIVE") throw new Error("The selected product must be active.");
  const inventoryQuantity = variant.inventoryQuantity === null || variant.inventoryQuantity === undefined ? null : Number(variant.inventoryQuantity);
  const tracked = Boolean(variant.inventoryItem && variant.inventoryItem.tracked);
  if (tracked && variant.inventoryPolicy === "DENY" && Number(inventoryQuantity || 0) < 1) {
    throw new Error("The selected product variant is out of stock.");
  }
  return {
    id: variant.id,
    numericId: numericId(variant.id),
    productId: variant.product.id,
    productTitle: variant.product.title,
    variantTitle: variant.title === "Default Title" ? "" : variant.title,
    imageUrl: variant.product.featuredMedia && variant.product.featuredMedia.preview && variant.product.featuredMedia.preview.image
      ? variant.product.featuredMedia.preview.image.url
      : null,
    price: Number(variant.price),
    currencyCode: body.data.shop.currencyCode,
    inventoryQuantity: inventoryQuantity,
    inventoryPolicy: variant.inventoryPolicy,
    inventoryTracked: tracked,
  };
}

export async function loadVariantForShop(shopDomain, variantId) {
  const context = await unauthenticated.admin(shopDomain);
  return loadVariant(context.admin, variantId);
}
`);

files.set("app/lib/offer.server.js", String.raw`import prisma from "../db.server";

export function discountedUnitPrice(price, discountType, discountValue) {
  const catalog = Math.max(0, Number(price || 0));
  const value = Math.max(0, Number(discountValue || 0));
  if (discountType === "PERCENTAGE") {
    return Math.max(0, catalog * (1 - Math.min(100, value) / 100));
  }
  if (discountType === "FIXED") {
    return Math.max(0, catalog - value);
  }
  return catalog;
}

export function changesetDiscount(offer) {
  const value = Number(offer.discountValue || 0);
  if (offer.discountType === "PERCENTAGE" && value > 0) {
    return {value: Math.min(100, value), valueType: "percentage", title: "Post-purchase offer"};
  }
  if (offer.discountType === "FIXED" && value > 0) {
    return {value: value, valueType: "fixed_amount", title: "Post-purchase offer"};
  }
  return null;
}

export function isOfferAvailable(offer, nowValue) {
  const now = nowValue || new Date();
  if (offer.status !== "ACTIVE") return false;
  if (offer.startsAt && new Date(offer.startsAt) > now) return false;
  if (offer.endsAt && new Date(offer.endsAt) <= now) return false;
  return true;
}

export function isOfferEligible(offer, context, nowValue) {
  if (!isOfferAvailable(offer, nowValue)) return false;
  const rules = offer.rules && typeof offer.rules === "object" ? offer.rules : {};
  const subtotal = Number(context.subtotal || 0);
  if (rules.minimumSubtotal !== null && rules.minimumSubtotal !== undefined && subtotal < Number(rules.minimumSubtotal)) return false;
  if (rules.maximumSubtotal !== null && rules.maximumSubtotal !== undefined && subtotal > Number(rules.maximumSubtotal)) return false;
  const countries = Array.isArray(rules.allowedCountries) ? rules.allowedCountries : [];
  if (countries.length && !countries.includes(String(context.countryCode || "").toUpperCase())) return false;
  const triggerVariants = Array.isArray(rules.triggerVariantIds) ? rules.triggerVariantIds : [];
  if (triggerVariants.length && !triggerVariants.some(function (id) { return context.variantIds.includes(id); })) return false;
  const triggerProducts = Array.isArray(rules.triggerProductIds) ? rules.triggerProductIds : [];
  if (triggerProducts.length && !triggerProducts.some(function (id) { return context.productIds.includes(id); })) return false;
  if (context.variantIds.includes(offer.productVariantId)) return false;
  return true;
}

export function serializeField(field) {
  return {
    key: field.key,
    type: field.type,
    label: field.label,
    placeholder: field.placeholder || "",
    helpText: field.helpText || "",
    required: field.required,
    minLength: field.minLength,
    maxLength: field.maxLength,
    options: Array.isArray(field.options) ? field.options : [],
  };
}

export function serializeOffer(offer, liveVariant) {
  const catalogPrice = Number(liveVariant.price);
  const unitPrice = discountedUnitPrice(catalogPrice, offer.discountType, offer.discountValue);
  const quantity = Math.max(1, Math.min(5, Number(offer.quantity || 1)));
  const discount = changesetDiscount(offer);
  const change = {
    type: "add_variant",
    variantId: liveVariant.numericId,
    quantity: quantity,
  };
  if (discount) change.discount = discount;
  return {
    id: offer.id,
    name: offer.name,
    headline: offer.headline,
    description: offer.description || "",
    buttonLabel: offer.buttonLabel,
    productTitle: liveVariant.productTitle,
    variantTitle: liveVariant.variantTitle,
    productImageUrl: liveVariant.imageUrl,
    originalPrice: (catalogPrice * quantity).toFixed(2),
    discountedPrice: (unitPrice * quantity).toFixed(2),
    currencyCode: liveVariant.currencyCode,
    quantity: quantity,
    fields: offer.fields.map(serializeField),
    previewChanges: [change],
  };
}

export async function recordEvent(data) {
  try {
    await prisma.offerEvent.create({data: data});
  } catch (error) {
    if (!error || error.code !== "P2002") throw error;
  }
}
`);

files.set("app/routes/api.sign-changeset.jsx", String.raw`import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {ensureShop, normalizeShop} from "../lib/shop.server";
import {enforceRateLimit, signShopifyChangeset, verifyOfferToken} from "../lib/security.server";
import {isOfferAvailable, discountedUnitPrice} from "../lib/offer.server";
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
    if (!offer || !isOfferAvailable(offer)) {
      throw new Response("Offer is no longer available", {status: 409});
    }
    const liveVariant = await loadVariantForShop(shopDomain, offer.productVariantId);
    const personalisation = validatePersonalisation(offer.fields, body.personalisation);
    const quantity = Math.max(1, Math.min(5, Number(offer.quantity || 1)));
    const expectedAmount = discountedUnitPrice(liveVariant.price, offer.discountType, offer.discountValue) * quantity;
    let reservation;
    try {
      reservation = await reserveAcceptance({
        shopId: shop.id,
        offerId: offer.id,
        referenceId: referenceId,
        personalisation: personalisation,
        expectedAmount: expectedAmount,
        currencyCode: liveVariant.currencyCode,
      });
    } catch (error) {
      if (error && error.code === "P2034") throw new Response("Concurrent acceptance", {status: 409});
      throw error;
    }
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

files.set("app/lib/order-reconciliation.server.js", String.raw`import prisma from "../db.server";
import {unauthenticated} from "../shopify.server";
import {hashCustomerEmail} from "./security.server";

const ORDER_QUERY = "#graphql\nquery PersonalisedOrder($id: ID!) {\n  order(id: $id) {\n    id\n    name\n    metafields(first: 100, namespace: \"personalised_upsell\") {\n      nodes { key value type }\n    }\n  }\n}";

export function customerGid(value) {
  const text = String(value || "");
  if (!text) return null;
  if (text.startsWith("gid://shopify/Customer/")) return text;
  if (/^\d+$/.test(text)) return "gid://shopify/Customer/" + text;
  return null;
}

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
  const customerId = customerGid(payload.customer && (payload.customer.admin_graphql_api_id || payload.customer.id));
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

files.set("app/routes/webhooks.customers.data_request.jsx", String.raw`import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {ensureShop} from "../lib/shop.server";
import {hashCustomerEmail, recordWebhook} from "../lib/security.server";
import {customerGid} from "../lib/order-reconciliation.server";

export async function action({request}) {
  const {payload, topic, shop} = await authenticate.webhook(request);
  const shopRecord = await ensureShop(shop);
  if (!await recordWebhook(request, shopRecord.id, topic)) return new Response();
  const customerId = customerGid(payload.customer && payload.customer.id);
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
import {customerGid} from "../lib/order-reconciliation.server";

export async function action({request}) {
  const {payload, topic, shop} = await authenticate.webhook(request);
  const shopRecord = await ensureShop(shop);
  if (!await recordWebhook(request, shopRecord.id, topic)) return new Response();
  const customerId = customerGid(payload.customer && payload.customer.id);
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

function gid(value, resource) {
  const text = String(value || "");
  if (!text) return "";
  if (text.startsWith("gid://shopify/" + resource + "/")) return text;
  return /^\d+$/.test(text) ? "gid://shopify/" + resource + "/" + text : "";
}

function purchaseContext(input) {
  const purchase = input && input.initialPurchase ? input.initialPurchase : {};
  const items = Array.isArray(purchase.lineItems) ? purchase.lineItems : [];
  return {
    variantIds: items.map(function (item) { return gid(item.variant && item.variant.id || item.variantId, "ProductVariant"); }).filter(Boolean),
    productIds: items.map(function (item) { return gid(item.product && item.product.id || item.productId, "Product"); }).filter(Boolean),
    subtotal: Number(purchase.subtotalPriceSet && purchase.subtotalPriceSet.presentmentMoney && purchase.subtotalPriceSet.presentmentMoney.amount || 0),
    countryCode: String(purchase.shippingAddress && purchase.shippingAddress.countryCode || ""),
  };
}

async function requestOffer(inputData) {
  const response = await fetch(APP_URL + "/api/offer", {
    method: "POST",
    headers: {Authorization: "Bearer " + inputData.token, "Content-Type": "application/json"},
    body: JSON.stringify({referenceId: inputData.initialPurchase.referenceId, purchase: purchaseContext(inputData)}),
  });
  if (!response.ok) return null;
  return response.json();
}

async function responseBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
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
    calculateChangeset({changes: offer.previewChanges}).then(function (result) { if (active) setCalculated(result.calculatedPurchase); }).catch(function () { if (active) setCalculated(null); });
    return function () { active = false; };
  }, [offer && offer.id]);

  if (!data) return <BlockStack spacing="loose"><TextBlock>Loading your optional offer…</TextBlock><Button onPress={done}>Continue to order</Button></BlockStack>;
  if (!offer) return <BlockStack spacing="loose"><TextBlock>This offer is no longer available. Your original order is confirmed.</TextBlock><Button onPress={done}>View my order</Button></BlockStack>;

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
    try {
      validate();
      const response = await fetch(APP_URL + "/api/sign-changeset", {
        method: "POST",
        headers: {Authorization: "Bearer " + inputData.token, "Content-Type": "application/json"},
        body: JSON.stringify({referenceId: inputData.initialPurchase.referenceId, offerToken: data.offerToken, personalisation: values}),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(body.error || "The offer could not be prepared.");
      const result = await applyChangeset(body.token);
      await fetch(APP_URL + "/api/acceptance-result", {
        method: "POST",
        headers: {Authorization: "Bearer " + inputData.token, "Content-Type": "application/json"},
        body: JSON.stringify({acceptanceId: body.acceptanceId, result: result.status}),
      }).catch(function () {});
      if (result.status !== "processed" && result.status !== "partially_processed") throw new Error(result.errors && result.errors[0] && result.errors[0].message || "The offer was not added.");
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

  return <BlockStack spacing="loose"><CalloutBanner title={offer.headline}><TextBlock>{offer.description || "Personalise it now and add it to your confirmed order."}</TextBlock></CalloutBanner>{offer.productImageUrl ? <Image source={offer.productImageUrl} /> : null}<Heading>{offer.productTitle}{offer.variantTitle ? " — " + offer.variantTitle : ""}</Heading><TextBlock>{offer.currencyCode} {offer.originalPrice} before offer · {offer.currencyCode} {offer.discountedPrice} after offer</TextBlock>{offer.fields.map(function (field) { return <PersonalisationField key={field.key} field={field} value={values[field.key]} onChange={function (value) { setValue(field.key, value); }} />; })}{error ? <CalloutBanner title="We could not add the optional item"><TextBlock>{error}</TextBlock><TextBlock>Your original order is still confirmed and has not been changed.</TextBlock></CalloutBanner> : null}<Separator /><TextBlock>Total to add: {currency} {total}</TextBlock><Button onPress={accept} loading={loading}>Add personalised item — {currency} {total}</Button><Button subdued onPress={decline} disabled={loading}>No thanks, view my order</Button></BlockStack>;
}

function PersonalisationField({field, value, onChange}) {
  if (field.type === "SELECT") {
    const options = [{label: "Select an option", value: ""}].concat(field.options.map(function (option) { return {label: option, value: option}; }));
    return <Select label={field.label} value={String(value || "")} options={options} onChange={onChange} />;
  }
  if (field.type === "CHECKBOX") return <Checkbox checked={Boolean(value)} onChange={onChange}>{field.label}</Checkbox>;
  return <BlockStack spacing="tight"><TextField label={field.label} value={String(value || "")} placeholder={field.placeholder || ""} required={field.required} onChange={onChange} />{field.helpText ? <TextBlock subdued>{field.helpText}</TextBlock> : null}{value ? <TextBlock>Preview: {String(value)}</TextBlock> : null}</BlockStack>;
}
`);

for (const [path, content] of files) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, content, "utf8");
}
