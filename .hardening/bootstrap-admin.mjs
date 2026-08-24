import {mkdir, writeFile} from "node:fs/promises";
import {dirname} from "node:path";

const files = new Map();

files.set("app/shopify.server.js", String.raw`import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import {PrismaSessionStorage} from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import {ensureShop} from "./lib/shop.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY || "",
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: (process.env.SCOPES || "read_products,read_orders").split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async function ({session}) {
      await ensureShop(session.shop);
      await shopify.registerWebhooks({session: session});
    },
  },
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
`);

files.set("app/lib/personalisation.js", String.raw`const FIELD_TYPES = new Set(["SHORT_TEXT", "LONG_TEXT", "SELECT", "CHECKBOX"]);

export function normalizeFieldKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function validateFieldDefinitions(input) {
  if (!Array.isArray(input)) throw new Error("Personalisation fields must be an array.");
  if (input.length < 1 || input.length > 5) {
    throw new Error("Create between one and five personalisation fields.");
  }
  const seen = new Set();
  return input.map(function (raw, index) {
    const type = String(raw.type || "SHORT_TEXT").toUpperCase();
    if (!FIELD_TYPES.has(type)) throw new Error("Unsupported field type.");
    const label = String(raw.label || "").trim().slice(0, 80);
    if (!label) throw new Error("Every personalisation field needs a label.");
    const key = normalizeFieldKey(raw.key || label);
    if (!key) throw new Error("Every personalisation field needs a valid key.");
    if (seen.has(key)) throw new Error("Personalisation field keys must be unique.");
    seen.add(key);
    const defaultMaximum = type === "LONG_TEXT" ? 500 : 100;
    const minLength = raw.minLength === null || raw.minLength === undefined || raw.minLength === ""
      ? null
      : Math.max(0, Math.min(500, Number(raw.minLength)));
    const maxLength = type === "CHECKBOX" || type === "SELECT"
      ? null
      : Math.max(1, Math.min(500, Number(raw.maxLength || defaultMaximum)));
    const options = type === "SELECT"
      ? Array.from(new Set((Array.isArray(raw.options) ? raw.options : String(raw.options || "").split(","))
          .map(function (value) { return String(value).trim(); })
          .filter(Boolean))).slice(0, 20)
      : [];
    if (type === "SELECT" && options.length < 1) {
      throw new Error(label + " needs at least one dropdown option.");
    }
    return {
      key: key,
      type: type,
      label: label,
      placeholder: String(raw.placeholder || "").trim().slice(0, 120) || null,
      helpText: String(raw.helpText || "").trim().slice(0, 240) || null,
      required: Boolean(raw.required),
      minLength: minLength,
      maxLength: maxLength,
      options: options,
      sortOrder: index,
    };
  });
}

export function validatePersonalisation(fields, values) {
  const source = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const output = {};
  for (const field of fields) {
    if (field.type === "CHECKBOX") {
      const checked = source[field.key] === true || source[field.key] === "true";
      if (field.required && !checked) throw new Error(field.label + " is required.");
      output[field.key] = checked;
      continue;
    }
    const value = String(source[field.key] || "").normalize("NFC").trim();
    const length = Array.from(value).length;
    if (field.required && !value) throw new Error(field.label + " is required.");
    if (field.minLength !== null && field.minLength !== undefined && value && length < field.minLength) {
      throw new Error(field.label + " must contain at least " + field.minLength + " characters.");
    }
    if (field.maxLength !== null && field.maxLength !== undefined && length > field.maxLength) {
      throw new Error(field.label + " must contain no more than " + field.maxLength + " characters.");
    }
    if (field.type === "SELECT") {
      const options = Array.isArray(field.options) ? field.options : [];
      if (value && !options.includes(value)) throw new Error(field.label + " contains an invalid selection.");
    }
    output[field.key] = value;
  }
  return output;
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

export function isOfferEligible(offer, context, nowValue) {
  const now = nowValue || new Date();
  if (offer.status !== "ACTIVE") return false;
  if (offer.startsAt && new Date(offer.startsAt) > now) return false;
  if (offer.endsAt && new Date(offer.endsAt) <= now) return false;
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

files.set("app/lib/shopify-product.server.js", String.raw`import {unauthenticated} from "../shopify.server";

const VARIANT_QUERY = "#graphql\nquery UpsellVariant($id: ID!) {\n  productVariant(id: $id) {\n    id\n    title\n    price\n    inventoryQuantity\n    inventoryPolicy\n    product {\n      id\n      title\n      status\n      featuredMedia {\n        preview {\n          image { url }\n        }\n      }\n    }\n  }\n  shop { currencyCode }\n}";

function numericId(gid) {
  const match = String(gid || "").match(/(\d+)$/);
  if (!match) throw new Error("The Shopify variant ID is invalid.");
  return Number(match[1]);
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
  const inventoryQuantity = Number(variant.inventoryQuantity || 0);
  if (variant.inventoryPolicy === "DENY" && inventoryQuantity < 1) {
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
  };
}

export async function loadVariantForShop(shopDomain, variantId) {
  const context = await unauthenticated.admin(shopDomain);
  return loadVariant(context.admin, variantId);
}
`);

files.set("app/lib/admin-offer.server.js", String.raw`import prisma from "../db.server";
import {loadVariant} from "./shopify-product.server";
import {validateFieldDefinitions} from "./personalisation";

function text(form, name, maximum) {
  return String(form.get(name) || "").trim().slice(0, maximum);
}

function optionalDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Enter a valid schedule date.");
  return date;
}

function idList(value, type) {
  return Array.from(new Set(String(value || "").split(/[\s,]+/).map(function (item) { return item.trim(); }).filter(Boolean)))
    .filter(function (item) { return item.startsWith("gid://shopify/" + type + "/"); })
    .slice(0, 100);
}

export async function parseOfferForm(form, admin) {
  const name = text(form, "name", 120);
  if (!name) throw new Error("Enter an internal offer name.");
  const variantId = text(form, "productVariantId", 120);
  const liveVariant = await loadVariant(admin, variantId);
  const status = form.get("active") === "on" ? "ACTIVE" : "DRAFT";
  const discountType = ["NONE", "PERCENTAGE", "FIXED"].includes(String(form.get("discountType")))
    ? String(form.get("discountType"))
    : "NONE";
  const discountValue = Math.max(0, Number(form.get("discountValue") || 0));
  if (discountType === "PERCENTAGE" && discountValue > 100) throw new Error("Percentage discount cannot exceed 100%.");
  if (discountType === "FIXED" && discountValue > liveVariant.price) throw new Error("Fixed discount cannot exceed the product price.");
  const quantity = Math.max(1, Math.min(5, Number(form.get("quantity") || 1)));
  let rawFields;
  try {
    rawFields = JSON.parse(String(form.get("fieldsJson") || "[]"));
  } catch {
    throw new Error("The personalisation field configuration is invalid.");
  }
  const fields = validateFieldDefinitions(rawFields);
  const minimumSubtotal = form.get("minimumSubtotal") === "" ? null : Math.max(0, Number(form.get("minimumSubtotal")));
  const maximumSubtotal = form.get("maximumSubtotal") === "" ? null : Math.max(0, Number(form.get("maximumSubtotal")));
  if (minimumSubtotal !== null && maximumSubtotal !== null && minimumSubtotal > maximumSubtotal) {
    throw new Error("Minimum subtotal cannot exceed maximum subtotal.");
  }
  const allowedCountries = Array.from(new Set(String(form.get("allowedCountries") || "")
    .split(/[\s,]+/)
    .map(function (country) { return country.trim().toUpperCase(); })
    .filter(function (country) { return /^[A-Z]{2}$/.test(country); })))
    .slice(0, 50);
  return {
    offer: {
      name: name,
      status: status,
      priority: Math.max(-1000, Math.min(1000, Number(form.get("priority") || 0))),
      productId: liveVariant.productId,
      productVariantId: liveVariant.id,
      productTitle: liveVariant.productTitle,
      variantTitle: liveVariant.variantTitle || null,
      productImageUrl: liveVariant.imageUrl,
      currencyCode: liveVariant.currencyCode,
      catalogPrice: liveVariant.price,
      quantity: quantity,
      discountType: discountType,
      discountValue: discountType === "NONE" ? 0 : discountValue,
      headline: text(form, "headline", 160) || "Add a personalised gift",
      description: text(form, "description", 1000) || null,
      buttonLabel: text(form, "buttonLabel", 100) || "Add personalised item",
      rules: {
        minimumSubtotal: minimumSubtotal,
        maximumSubtotal: maximumSubtotal,
        allowedCountries: allowedCountries,
        triggerProductIds: idList(form.get("triggerProductIds"), "Product"),
        triggerVariantIds: idList(form.get("triggerVariantIds"), "ProductVariant"),
      },
      startsAt: optionalDate(form.get("startsAt")),
      endsAt: optionalDate(form.get("endsAt")),
    },
    fields: fields,
  };
}

export async function createOffer(shopId, parsed) {
  return prisma.offer.create({
    data: {
      ...parsed.offer,
      shopId: shopId,
      fields: {create: parsed.fields},
    },
  });
}

export async function updateOffer(shopId, offerId, parsed) {
  const existing = await prisma.offer.findFirst({where: {id: offerId, shopId: shopId}});
  if (!existing) throw new Response("Not found", {status: 404});
  return prisma.$transaction(async function (tx) {
    await tx.personalisationField.deleteMany({where: {offerId: offerId}});
    return tx.offer.update({
      where: {id: offerId},
      data: {
        ...parsed.offer,
        fields: {create: parsed.fields},
      },
    });
  });
}
`);

files.set("app/routes.js", String.raw`import {flatRoutes} from "@react-router/fs-routes";

export default flatRoutes();
`);

files.set("app/entry.server.jsx", String.raw`import {PassThrough} from "node:stream";
import {createReadableStreamFromReadable} from "@react-router/node";
import {ServerRouter} from "react-router";
import {isbot} from "isbot";
import {renderToPipeableStream} from "react-dom/server";
import {addDocumentResponseHeaders} from "./shopify.server";

const ABORT_DELAY = 5000;

export default function handleRequest(request, responseStatusCode, responseHeaders, routerContext) {
  addDocumentResponseHeaders(request, responseHeaders);
  const callbackName = isbot(request.headers.get("user-agent")) ? "onAllReady" : "onShellReady";
  return new Promise(function (resolve, reject) {
    let shellRendered = false;
    const stream = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [callbackName]: function () {
          shellRendered = true;
          const body = new PassThrough();
          const readable = createReadableStreamFromReadable(body);
          responseHeaders.set("Content-Type", "text/html");
          resolve(new Response(readable, {headers: responseHeaders, status: responseStatusCode}));
          stream.pipe(body);
        },
        onShellError: reject,
        onError: function (error) {
          responseStatusCode = 500;
          if (shellRendered) console.error(error);
        },
      },
    );
    setTimeout(stream.abort, ABORT_DELAY);
  });
}
`);

files.set("app/styles.css", String.raw`:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #202223;
  background: #f6f6f7;
}
* { box-sizing: border-box; }
body { margin: 0; background: #f6f6f7; }
a { color: inherit; }
button, input, select, textarea { font: inherit; }
.shell { min-height: 100vh; }
.nav { display: flex; gap: 8px; align-items: center; padding: 12px 24px; background: #fff; border-bottom: 1px solid #e1e3e5; position: sticky; top: 0; z-index: 5; }
.nav strong { margin-right: 16px; }
.nav a { text-decoration: none; padding: 8px 10px; border-radius: 8px; }
.nav a:hover { background: #f1f2f3; }
.page { max-width: 1180px; margin: 0 auto; padding: 28px 24px 64px; }
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
h1 { margin: 0 0 6px; font-size: 28px; }
h2 { margin: 0 0 14px; font-size: 20px; }
h3 { margin: 0 0 10px; font-size: 16px; }
p { line-height: 1.5; }
.muted { color: #6d7175; }
.grid { display: grid; gap: 16px; }
.grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.card { background: #fff; border: 1px solid #e1e3e5; border-radius: 12px; padding: 20px; box-shadow: 0 1px 0 rgba(0,0,0,.03); }
.metric { font-size: 30px; font-weight: 700; margin-top: 8px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid #8c9196; border-radius: 8px; padding: 9px 14px; background: #fff; color: #202223; text-decoration: none; cursor: pointer; font-weight: 600; }
.btn-primary { background: #008060; color: #fff; border-color: #008060; }
.btn-danger { color: #b42318; border-color: #f0b5b0; }
.btn:disabled { opacity: .55; cursor: wait; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; }
.field { display: grid; gap: 6px; margin-bottom: 14px; }
.field label { font-weight: 600; }
.field input, .field select, .field textarea { width: 100%; border: 1px solid #8c9196; border-radius: 8px; padding: 10px 12px; background: #fff; }
.field textarea { min-height: 90px; resize: vertical; }
.help { color: #6d7175; font-size: 13px; }
.checkbox { display: flex; align-items: center; gap: 8px; margin: 10px 0 16px; }
.notice { border-radius: 10px; padding: 12px 14px; margin-bottom: 16px; background: #fff5ea; border: 1px solid #f5c99b; }
.error { background: #fff1f0; border-color: #f4b8b4; color: #8e1f15; }
.success { background: #eafaf3; border-color: #9bd8c1; color: #0f5132; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; border-bottom: 1px solid #e1e3e5; padding: 12px 10px; vertical-align: top; }
th { font-size: 13px; color: #6d7175; }
.badge { display: inline-flex; border-radius: 999px; padding: 4px 9px; font-size: 12px; font-weight: 700; background: #edf0f2; }
.badge-active { background: #d1f0e2; color: #0b5c40; }
.badge-draft { background: #fff0c2; color: #6b4f00; }
.product { display: flex; gap: 14px; align-items: center; }
.product img { width: 72px; height: 72px; object-fit: cover; border-radius: 8px; border: 1px solid #e1e3e5; }
.field-builder { border: 1px solid #e1e3e5; border-radius: 10px; padding: 14px; margin-bottom: 12px; }
.field-row { display: grid; grid-template-columns: 1fr 180px 90px; gap: 10px; align-items: end; }
.empty { text-align: center; padding: 44px 20px; color: #6d7175; }
.code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 850px) {
  .grid-4, .grid-2 { grid-template-columns: 1fr; }
  .nav { overflow-x: auto; padding: 10px 14px; }
  .page { padding: 20px 14px 48px; }
  .page-header { flex-direction: column; }
  .field-row { grid-template-columns: 1fr; }
  table { display: block; overflow-x: auto; }
}
`);

files.set("app/root.jsx", String.raw`import {Links, Meta, Outlet, Scripts, ScrollRestoration} from "react-router";
import stylesheet from "./styles.css?url";

export const links = function () {
  return [{rel: "stylesheet", href: stylesheet}];
};

export function Layout({children}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}
`);

files.set("app/routes/_index.jsx", String.raw`import {redirect} from "react-router";

export async function loader() {
  return redirect("/app");
}

export default function Index() {
  return null;
}
`);

files.set("app/routes/auth.$.jsx", String.raw`import {login} from "../shopify.server";

export async function loader({request}) {
  return login(request);
}

export async function action({request}) {
  return login(request);
}

export default function AuthRoute() {
  return null;
}
`);

files.set("app/routes/app.jsx", String.raw`import {Outlet, Link, useLoaderData, useRouteError} from "react-router";
import {boundary} from "@shopify/shopify-app-react-router/server";
import {AppProvider} from "@shopify/shopify-app-react-router/react";
import {authenticate} from "../shopify.server";

export async function loader({request}) {
  await authenticate.admin(request);
  return {apiKey: process.env.SHOPIFY_API_KEY || ""};
}

export default function EmbeddedApp() {
  const {apiKey} = useLoaderData();
  return (
    <AppProvider embedded apiKey={apiKey}>
      <div className="shell">
        <nav className="nav" aria-label="Application navigation">
          <strong>Personalised Upsell</strong>
          <Link to="/app">Dashboard</Link>
          <Link to="/app/offers">Offers</Link>
          <Link to="/app/orders">Production queue</Link>
          <Link to="/app/analytics">Analytics</Link>
          <Link to="/app/settings">Settings</Link>
          <Link to="/app/privacy">Privacy</Link>
        </nav>
        <Outlet />
      </div>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = function (args) {
  return boundary.headers(args);
};
`);

files.set("app/routes/app._index.jsx", String.raw`import {Link, useLoaderData} from "react-router";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";
import {shopForSession} from "../lib/shop.server";

export async function loader({request}) {
  const {session} = await authenticate.admin(request);
  const shop = await shopForSession(session);
  const [activeOffers, allOffers, processed, views, recent] = await Promise.all([
    prisma.offer.count({where: {shopId: shop.id, status: "ACTIVE"}}),
    prisma.offer.count({where: {shopId: shop.id, status: {not: "ARCHIVED"}}}),
    prisma.acceptance.findMany({
      where: {shopId: shop.id, status: {in: ["PROCESSED", "PARTIAL"]}},
      select: {expectedAmount: true},
    }),
    prisma.offerEvent.count({where: {shopId: shop.id, type: "VIEW"}}),
    prisma.acceptance.findMany({
      where: {shopId: shop.id},
      include: {offer: {select: {name: true}}},
      orderBy: {createdAt: "desc"},
      take: 8,
    }),
  ]);
  const revenue = processed.reduce(function (sum, item) { return sum + Number(item.expectedAmount); }, 0);
  const accepted = processed.length;
  return {
    activeOffers: activeOffers,
    allOffers: allOffers,
    accepted: accepted,
    views: views,
    revenue: revenue,
    conversion: views ? accepted / views * 100 : 0,
    recent: recent.map(function (item) {
      return {
        id: item.id,
        offerName: item.offer.name,
        orderName: item.orderName || "Awaiting order reconciliation",
        status: item.status,
        productionStatus: item.productionStatus,
        amount: Number(item.expectedAmount),
        currencyCode: item.currencyCode,
        createdAt: item.createdAt.toISOString(),
      };
    }),
  };
}

export default function Dashboard() {
  const data = useLoaderData();
  return (
    <main className="page">
      <div className="page-header">
        <div><h1>Post-purchase performance</h1><p className="muted">Personalised offer revenue and production status.</p></div>
        <Link className="btn btn-primary" to="/app/offers/new">Create offer</Link>
      </div>
      <div className="grid grid-4">
        <section className="card"><span className="muted">Active offers</span><div className="metric">{data.activeOffers}</div></section>
        <section className="card"><span className="muted">Offer views</span><div className="metric">{data.views}</div></section>
        <section className="card"><span className="muted">Conversion</span><div className="metric">{data.conversion.toFixed(1)}%</div></section>
        <section className="card"><span className="muted">Expected upsell revenue</span><div className="metric">{data.revenue.toFixed(2)}</div></section>
      </div>
      <section className="card" style={{marginTop: 18}}>
        <div className="page-header"><div><h2>Recent personalised items</h2><p className="muted">Accepted changesets are reconciled against Shopify order metafields.</p></div><Link className="btn" to="/app/orders">Open queue</Link></div>
        {data.recent.length ? (
          <table><thead><tr><th>Offer</th><th>Order</th><th>Payment state</th><th>Production</th><th>Amount</th></tr></thead><tbody>
            {data.recent.map(function (item) { return <tr key={item.id}><td>{item.offerName}</td><td>{item.orderName}</td><td>{item.status}</td><td>{item.productionStatus}</td><td>{item.currencyCode} {item.amount.toFixed(2)}</td></tr>; })}
          </tbody></table>
        ) : <div className="empty">No post-purchase acceptances yet.</div>}
      </section>
    </main>
  );
}
`);

files.set("app/routes/app.offers._index.jsx", String.raw`import {Form, Link, useLoaderData} from "react-router";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";
import {shopForSession} from "../lib/shop.server";

export async function loader({request}) {
  const {session} = await authenticate.admin(request);
  const shop = await shopForSession(session);
  const offers = await prisma.offer.findMany({
    where: {shopId: shop.id, status: {not: "ARCHIVED"}},
    include: {_count: {select: {acceptances: true, events: true}}},
    orderBy: [{priority: "desc"}, {createdAt: "desc"}],
  });
  return {offers: offers.map(function (offer) {
    return {
      id: offer.id,
      name: offer.name,
      status: offer.status,
      productTitle: offer.productTitle,
      variantTitle: offer.variantTitle,
      imageUrl: offer.productImageUrl,
      price: Number(offer.catalogPrice),
      currencyCode: offer.currencyCode,
      acceptances: offer._count.acceptances,
      events: offer._count.events,
    };
  })};
}

export async function action({request}) {
  const {session} = await authenticate.admin(request);
  const shop = await shopForSession(session);
  const form = await request.formData();
  const id = String(form.get("id") || "");
  const offer = await prisma.offer.findFirst({where: {id: id, shopId: shop.id}});
  if (!offer) throw new Response("Not found", {status: 404});
  await prisma.offer.update({where: {id: id}, data: {status: "ARCHIVED"}});
  return {ok: true};
}

export default function Offers() {
  const {offers} = useLoaderData();
  return (
    <main className="page">
      <div className="page-header"><div><h1>Offers</h1><p className="muted">Configure targeting, discounts and customer personalisation fields.</p></div><Link className="btn btn-primary" to="/app/offers/new">Create offer</Link></div>
      <section className="card">
        {offers.length ? <table><thead><tr><th>Product</th><th>Status</th><th>Views</th><th>Acceptances</th><th></th></tr></thead><tbody>
          {offers.map(function (offer) { return <tr key={offer.id}><td><div className="product">{offer.imageUrl ? <img src={offer.imageUrl} alt="" /> : null}<div><strong>{offer.name}</strong><div className="muted">{offer.productTitle}{offer.variantTitle ? " — " + offer.variantTitle : ""}</div><div>{offer.currencyCode} {offer.price.toFixed(2)}</div></div></div></td><td><span className={"badge " + (offer.status === "ACTIVE" ? "badge-active" : "badge-draft")}>{offer.status}</span></td><td>{offer.events}</td><td>{offer.acceptances}</td><td><div className="actions"><Link className="btn" to={"/app/offers/" + offer.id}>Edit</Link><Form method="post"><input type="hidden" name="id" value={offer.id} /><button className="btn btn-danger" type="submit">Archive</button></Form></div></td></tr>; })}
        </tbody></table> : <div className="empty"><h2>No offers yet</h2><p>Create a personalised product offer to show after eligible checkouts.</p><Link className="btn btn-primary" to="/app/offers/new">Create first offer</Link></div>}
      </section>
    </main>
  );
}
`);

files.set("app/components/OfferEditor.jsx", String.raw`import {useState} from "react";
import {Form, Link, useActionData, useNavigation} from "react-router";

function blankField() {
  return {key: "name", type: "SHORT_TEXT", label: "Name to print", placeholder: "e.g. Amelia", helpText: "Check the spelling carefully.", required: true, minLength: 1, maxLength: 20, options: []};
}

function localDate(value) {
  return value ? new Date(value).toISOString().slice(0, 16) : "";
}

export default function OfferEditor({offer, fields}) {
  const actionData = useActionData();
  const navigation = useNavigation();
  const [product, setProduct] = useState({
    productId: offer.productId || "",
    variantId: offer.productVariantId || "",
    title: offer.productTitle || "",
    variantTitle: offer.variantTitle || "",
    imageUrl: offer.productImageUrl || "",
    price: offer.catalogPrice || "",
    currencyCode: offer.currencyCode || "",
  });
  const [personalisationFields, setPersonalisationFields] = useState(fields && fields.length ? fields : [blankField()]);

  async function pickProduct() {
    if (!window.shopify || !window.shopify.resourcePicker) {
      window.alert("Open this page inside Shopify Admin to use the product picker.");
      return;
    }
    const selection = await window.shopify.resourcePicker({
      type: "product",
      multiple: false,
      filter: {variants: true, draft: false, archived: false},
    });
    if (!selection || !selection.length) return;
    const selectedProduct = selection[0];
    const variant = selectedProduct.variants && selectedProduct.variants.length ? selectedProduct.variants[0] : null;
    if (!variant) {
      window.alert("Choose a product variant.");
      return;
    }
    const image = selectedProduct.images && selectedProduct.images.length ? selectedProduct.images[0].originalSrc || selectedProduct.images[0].source : "";
    setProduct({
      productId: selectedProduct.id,
      variantId: variant.id,
      title: selectedProduct.title,
      variantTitle: variant.title === "Default Title" ? "" : variant.title,
      imageUrl: image || "",
      price: variant.price || "",
      currencyCode: product.currencyCode || "",
    });
  }

  function updateField(index, key, value) {
    setPersonalisationFields(function (current) {
      return current.map(function (field, fieldIndex) {
        return fieldIndex === index ? {...field, [key]: value} : field;
      });
    });
  }

  function addField() {
    if (personalisationFields.length >= 5) return;
    setPersonalisationFields(function (current) {
      return current.concat([{...blankField(), key: "field_" + (current.length + 1), label: "Personalisation option", required: false}]);
    });
  }

  function removeField(index) {
    setPersonalisationFields(function (current) { return current.filter(function (_, fieldIndex) { return fieldIndex !== index; }); });
  }

  const rules = offer.rules || {};
  return (
    <main className="page">
      <div className="page-header"><div><h1>{offer.id ? "Edit offer" : "Create offer"}</h1><p className="muted">All product pricing and inventory are re-verified by the server before a changeset is signed.</p></div><Link className="btn" to="/app/offers">Back to offers</Link></div>
      {actionData && actionData.errors ? <div className="notice error" role="alert">{actionData.errors.join(" ")}</div> : null}
      <Form method="post">
        <input type="hidden" name="productVariantId" value={product.variantId} />
        <input type="hidden" name="fieldsJson" value={JSON.stringify(personalisationFields)} />
        <div className="grid grid-2">
          <div className="grid">
            <section className="card"><h2>Offer details</h2>
              <div className="field"><label htmlFor="name">Internal name</label><input id="name" name="name" required maxLength="120" defaultValue={offer.name || "Personalised product upsell"} /></div>
              <div className="field"><label>Shopify product variant</label>{product.variantId ? <div className="product">{product.imageUrl ? <img src={product.imageUrl} alt="" /> : null}<div><strong>{product.title}</strong><div className="muted">{product.variantTitle}</div><div className="code">{product.variantId}</div></div></div> : <p className="muted">No product selected.</p>}<div><button className="btn" type="button" onClick={pickProduct}>Choose product</button></div></div>
              <div className="field"><label htmlFor="headline">Customer headline</label><input id="headline" name="headline" required maxLength="160" defaultValue={offer.headline || "Add a personalised gift"} /></div>
              <div className="field"><label htmlFor="description">Description</label><textarea id="description" name="description" maxLength="1000" defaultValue={offer.description || "Personalise this product and add it to your confirmed order."} /></div>
              <div className="field"><label htmlFor="buttonLabel">Acceptance button</label><input id="buttonLabel" name="buttonLabel" maxLength="100" defaultValue={offer.buttonLabel || "Add personalised item"} /></div>
              <label className="checkbox"><input type="checkbox" name="active" defaultChecked={offer.status === "ACTIVE"} /> Offer active</label>
            </section>
            <section className="card"><div className="page-header"><div><h2>Personalisation fields</h2><p className="muted">One to five customer inputs.</p></div><button className="btn" type="button" onClick={addField} disabled={personalisationFields.length >= 5}>Add field</button></div>
              {personalisationFields.map(function (field, index) { return <div className="field-builder" key={index}><div className="field-row"><div className="field"><label>Label</label><input value={field.label} maxLength="80" onChange={function (event) { updateField(index, "label", event.target.value); }} /></div><div className="field"><label>Type</label><select value={field.type} onChange={function (event) { updateField(index, "type", event.target.value); }}><option value="SHORT_TEXT">Short text</option><option value="LONG_TEXT">Long text</option><option value="SELECT">Dropdown</option><option value="CHECKBOX">Checkbox</option></select></div><button className="btn btn-danger" type="button" onClick={function () { removeField(index); }} disabled={personalisationFields.length <= 1}>Remove</button></div>
                <div className="grid grid-2"><div className="field"><label>Key</label><input value={field.key} maxLength="40" onChange={function (event) { updateField(index, "key", event.target.value); }} /></div><div className="field"><label>Placeholder</label><input value={field.placeholder || ""} maxLength="120" onChange={function (event) { updateField(index, "placeholder", event.target.value); }} /></div></div>
                {field.type === "SELECT" ? <div className="field"><label>Options, comma separated</label><input value={Array.isArray(field.options) ? field.options.join(", ") : field.options || ""} onChange={function (event) { updateField(index, "options", event.target.value.split(",").map(function (value) { return value.trim(); }).filter(Boolean)); }} /></div> : null}
                {field.type === "SHORT_TEXT" || field.type === "LONG_TEXT" ? <div className="grid grid-2"><div className="field"><label>Minimum length</label><input type="number" min="0" max="500" value={field.minLength === null || field.minLength === undefined ? "" : field.minLength} onChange={function (event) { updateField(index, "minLength", event.target.value); }} /></div><div className="field"><label>Maximum length</label><input type="number" min="1" max="500" value={field.maxLength || ""} onChange={function (event) { updateField(index, "maxLength", event.target.value); }} /></div></div> : null}
                <label className="checkbox"><input type="checkbox" checked={Boolean(field.required)} onChange={function (event) { updateField(index, "required", event.target.checked); }} /> Required</label>
              </div>; })}
            </section>
          </div>
          <div className="grid">
            <section className="card"><h2>Pricing</h2><div className="grid grid-2"><div className="field"><label htmlFor="quantity">Quantity</label><input id="quantity" name="quantity" type="number" min="1" max="5" defaultValue={offer.quantity || 1} /></div><div className="field"><label htmlFor="priority">Priority</label><input id="priority" name="priority" type="number" min="-1000" max="1000" defaultValue={offer.priority || 0} /></div></div><div className="grid grid-2"><div className="field"><label htmlFor="discountType">Discount</label><select id="discountType" name="discountType" defaultValue={offer.discountType || "NONE"}><option value="NONE">No discount</option><option value="PERCENTAGE">Percentage</option><option value="FIXED">Fixed amount</option></select></div><div className="field"><label htmlFor="discountValue">Discount value</label><input id="discountValue" name="discountValue" type="number" min="0" step="0.01" defaultValue={offer.discountValue || 0} /></div></div></section>
            <section className="card"><h2>Eligibility</h2><div className="grid grid-2"><div className="field"><label htmlFor="minimumSubtotal">Minimum original subtotal</label><input id="minimumSubtotal" name="minimumSubtotal" type="number" min="0" step="0.01" defaultValue={rules.minimumSubtotal === null || rules.minimumSubtotal === undefined ? "" : rules.minimumSubtotal} /></div><div className="field"><label htmlFor="maximumSubtotal">Maximum original subtotal</label><input id="maximumSubtotal" name="maximumSubtotal" type="number" min="0" step="0.01" defaultValue={rules.maximumSubtotal === null || rules.maximumSubtotal === undefined ? "" : rules.maximumSubtotal} /></div></div><div className="field"><label htmlFor="allowedCountries">Allowed country codes</label><input id="allowedCountries" name="allowedCountries" placeholder="GB, US, CA" defaultValue={(rules.allowedCountries || []).join(", ")} /><span className="help">Leave empty for all countries.</span></div><div className="field"><label htmlFor="triggerProductIds">Trigger product GIDs</label><textarea id="triggerProductIds" name="triggerProductIds" defaultValue={(rules.triggerProductIds || []).join("\n")} /><span className="help">Leave empty to allow any original product.</span></div><div className="field"><label htmlFor="triggerVariantIds">Trigger variant GIDs</label><textarea id="triggerVariantIds" name="triggerVariantIds" defaultValue={(rules.triggerVariantIds || []).join("\n")} /></div></section>
            <section className="card"><h2>Schedule</h2><div className="grid grid-2"><div className="field"><label htmlFor="startsAt">Starts</label><input id="startsAt" name="startsAt" type="datetime-local" defaultValue={localDate(offer.startsAt)} /></div><div className="field"><label htmlFor="endsAt">Ends</label><input id="endsAt" name="endsAt" type="datetime-local" defaultValue={localDate(offer.endsAt)} /></div></div></section>
            <section className="card"><div className="actions"><button className="btn btn-primary" type="submit" disabled={navigation.state !== "idle" || !product.variantId}>{navigation.state === "submitting" ? "Saving…" : "Save offer"}</button><Link className="btn" to="/app/offers">Cancel</Link></div></section>
          </div>
        </div>
      </Form>
    </main>
  );
}
`);

files.set("app/routes/app.offers.new.jsx", String.raw`import {redirect} from "react-router";
import OfferEditor from "../components/OfferEditor";
import {authenticate} from "../shopify.server";
import {shopForSession} from "../lib/shop.server";
import {createOffer, parseOfferForm} from "../lib/admin-offer.server";

export async function loader({request}) {
  await authenticate.admin(request);
  return null;
}

export async function action({request}) {
  const {session, admin} = await authenticate.admin(request);
  const shop = await shopForSession(session);
  try {
    const parsed = await parseOfferForm(await request.formData(), admin);
    const offer = await createOffer(shop.id, parsed);
    return redirect("/app/offers/" + offer.id);
  } catch (error) {
    if (error instanceof Response) throw error;
    return {errors: [error.message || "The offer could not be saved."]};
  }
}

export default function NewOffer() {
  return <OfferEditor offer={{status: "DRAFT", rules: {}}} fields={[]} />;
}
`);

files.set("app/routes/app.offers.$id.jsx", String.raw`import {redirect, useLoaderData} from "react-router";
import OfferEditor from "../components/OfferEditor";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";
import {shopForSession} from "../lib/shop.server";
import {parseOfferForm, updateOffer} from "../lib/admin-offer.server";

export async function loader({request, params}) {
  const {session} = await authenticate.admin(request);
  const shop = await shopForSession(session);
  const offer = await prisma.offer.findFirst({
    where: {id: params.id, shopId: shop.id},
    include: {fields: {orderBy: {sortOrder: "asc"}}},
  });
  if (!offer) throw new Response("Not found", {status: 404});
  return {
    offer: {
      ...offer,
      catalogPrice: Number(offer.catalogPrice),
      discountValue: Number(offer.discountValue),
      startsAt: offer.startsAt ? offer.startsAt.toISOString() : null,
      endsAt: offer.endsAt ? offer.endsAt.toISOString() : null,
      createdAt: offer.createdAt.toISOString(),
      updatedAt: offer.updatedAt.toISOString(),
    },
    fields: offer.fields.map(function (field) {
      return {...field, options: Array.isArray(field.options) ? field.options : []};
    }),
  };
}

export async function action({request, params}) {
  const {session, admin} = await authenticate.admin(request);
  const shop = await shopForSession(session);
  try {
    const parsed = await parseOfferForm(await request.formData(), admin);
    await updateOffer(shop.id, params.id, parsed);
    return redirect("/app/offers/" + params.id);
  } catch (error) {
    if (error instanceof Response) throw error;
    return {errors: [error.message || "The offer could not be saved."]};
  }
}

export default function EditOffer() {
  const data = useLoaderData();
  return <OfferEditor offer={data.offer} fields={data.fields} />;
}
`);

files.set("app/routes/app.orders.jsx", String.raw`import {Form, useLoaderData} from "react-router";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";
import {shopForSession} from "../lib/shop.server";

const PRODUCTION_STATES = ["NEW", "APPROVED", "IN_PRODUCTION", "COMPLETED", "CANCELLED"];

export async function loader({request}) {
  const {session} = await authenticate.admin(request);
  const shop = await shopForSession(session);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const where = {shopId: shop.id};
  if (PRODUCTION_STATES.includes(status)) where.productionStatus = status;
  const items = await prisma.acceptance.findMany({
    where: where,
    include: {offer: {select: {name: true, productTitle: true, variantTitle: true}}},
    orderBy: {createdAt: "desc"},
    take: 250,
  });
  return {items: items.map(function (item) {
    return {
      id: item.id,
      orderName: item.orderName || "Awaiting reconciliation",
      paymentStatus: item.status,
      productionStatus: item.productionStatus,
      offer: item.offer,
      personalisation: item.personalisation,
      amount: Number(item.expectedAmount),
      currencyCode: item.currencyCode,
      createdAt: item.createdAt.toISOString(),
    };
  })};
}

export async function action({request}) {
  const {session} = await authenticate.admin(request);
  const shop = await shopForSession(session);
  const form = await request.formData();
  const id = String(form.get("id") || "");
  const status = String(form.get("productionStatus") || "");
  if (!PRODUCTION_STATES.includes(status)) throw new Response("Invalid status", {status: 400});
  const item = await prisma.acceptance.findFirst({where: {id: id, shopId: shop.id}});
  if (!item) throw new Response("Not found", {status: 404});
  await prisma.acceptance.update({where: {id: id}, data: {productionStatus: status}});
  return {ok: true};
}

export default function Orders() {
  const {items} = useLoaderData();
  return <main className="page"><div className="page-header"><div><h1>Production queue</h1><p className="muted">Personalisation is shown only to authenticated staff inside Shopify Admin.</p></div></div><section className="card">{items.length ? <table><thead><tr><th>Order</th><th>Product</th><th>Personalisation</th><th>Payment</th><th>Production</th></tr></thead><tbody>{items.map(function (item) { return <tr key={item.id}><td><strong>{item.orderName}</strong><div className="muted">{new Date(item.createdAt).toLocaleString()}</div></td><td>{item.offer.productTitle}<div className="muted">{item.offer.variantTitle}</div></td><td>{Object.entries(item.personalisation || {}).map(function ([key, value]) { return <div key={key}><strong>{key}:</strong> {String(value)}</div>; })}</td><td>{item.paymentStatus}<div>{item.currencyCode} {item.amount.toFixed(2)}</div></td><td><Form method="post"><input type="hidden" name="id" value={item.id} /><select name="productionStatus" defaultValue={item.productionStatus} onChange={function (event) { event.currentTarget.form.requestSubmit(); }}>{PRODUCTION_STATES.map(function (state) { return <option key={state}>{state}</option>; })}</select></Form></td></tr>; })}</tbody></table> : <div className="empty">No personalised products are waiting for production.</div>}</section></main>;
}
`);

files.set("app/routes/app.analytics.jsx", String.raw`import {useLoaderData} from "react-router";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";
import {shopForSession} from "../lib/shop.server";

export async function loader({request}) {
  const {session} = await authenticate.admin(request);
  const shop = await shopForSession(session);
  const offers = await prisma.offer.findMany({
    where: {shopId: shop.id, status: {not: "ARCHIVED"}},
    include: {events: true, acceptances: {where: {status: {in: ["PROCESSED", "PARTIAL"]}}}},
    orderBy: {createdAt: "desc"},
  });
  return {offers: offers.map(function (offer) {
    const views = offer.events.filter(function (event) { return event.type === "VIEW"; }).length;
    const accepts = offer.acceptances.length;
    const revenue = offer.acceptances.reduce(function (sum, item) { return sum + Number(item.expectedAmount); }, 0);
    return {id: offer.id, name: offer.name, views: views, accepts: accepts, conversion: views ? accepts / views * 100 : 0, revenue: revenue, currencyCode: offer.currencyCode};
  })};
}

export default function Analytics() {
  const {offers} = useLoaderData();
  return <main className="page"><div className="page-header"><div><h1>Analytics</h1><p className="muted">App-owned acceptance metrics, independent of storefront pixel attribution.</p></div></div><section className="card">{offers.length ? <table><thead><tr><th>Offer</th><th>Views</th><th>Accepted</th><th>Conversion</th><th>Expected revenue</th></tr></thead><tbody>{offers.map(function (offer) { return <tr key={offer.id}><td>{offer.name}</td><td>{offer.views}</td><td>{offer.accepts}</td><td>{offer.conversion.toFixed(1)}%</td><td>{offer.currencyCode} {offer.revenue.toFixed(2)}</td></tr>; })}</tbody></table> : <div className="empty">Create an offer to begin collecting metrics.</div>}</section></main>;
}
`);

files.set("app/routes/app.settings.jsx", String.raw`import {Form, useActionData, useLoaderData} from "react-router";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";
import {shopForSession} from "../lib/shop.server";

export async function loader({request}) {
  const {session} = await authenticate.admin(request);
  const shop = await shopForSession(session);
  return {domain: shop.domain, retentionDays: shop.retentionDays};
}

export async function action({request}) {
  const {session} = await authenticate.admin(request);
  const shop = await shopForSession(session);
  const form = await request.formData();
  const retentionDays = Math.max(30, Math.min(730, Number(form.get("retentionDays") || 365)));
  await prisma.shop.update({where: {id: shop.id}, data: {retentionDays: retentionDays}});
  return {ok: true};
}

export default function Settings() {
  const data = useLoaderData();
  const result = useActionData();
  return <main className="page"><div className="page-header"><div><h1>Settings</h1><p className="muted">Store-specific retention and operational controls.</p></div></div>{result && result.ok ? <div className="notice success">Settings saved.</div> : null}<section className="card"><h2>Data retention</h2><p className="muted">Personalisation and customer references are purged by the authenticated retention job after this period.</p><Form method="post"><div className="field"><label htmlFor="retentionDays">Retention period in days</label><input id="retentionDays" name="retentionDays" type="number" min="30" max="730" defaultValue={data.retentionDays} /></div><button className="btn btn-primary" type="submit">Save settings</button></Form></section><section className="card" style={{marginTop: 16}}><h2>Installed store</h2><p className="code">{data.domain}</p></section></main>;
}
`);

files.set("app/routes/app.privacy.jsx", String.raw`import {useLoaderData} from "react-router";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";
import {shopForSession} from "../lib/shop.server";

export async function loader({request}) {
  const {session} = await authenticate.admin(request);
  const shop = await shopForSession(session);
  const requests = await prisma.privacyRequest.findMany({where: {shopDomain: shop.domain}, orderBy: {createdAt: "desc"}, take: 100});
  return {requests: requests.map(function (item) { return {...item, createdAt: item.createdAt.toISOString(), completedAt: item.completedAt ? item.completedAt.toISOString() : null, expiresAt: item.expiresAt.toISOString()}; })};
}

export default function Privacy() {
  const {requests} = useLoaderData();
  return <main className="page"><div className="page-header"><div><h1>Privacy requests</h1><p className="muted">Verified Shopify compliance webhooks are processed automatically and retained for 30 days.</p></div></div><section className="card">{requests.length ? <table><thead><tr><th>Received</th><th>Type</th><th>Status</th><th>Result</th></tr></thead><tbody>{requests.map(function (item) { return <tr key={item.id}><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.requestType}</td><td>{item.status}</td><td><pre className="code">{item.result ? JSON.stringify(item.result, null, 2) : item.error || "—"}</pre></td></tr>; })}</tbody></table> : <div className="empty">No privacy requests have been received.</div>}</section></main>;
}
`);

files.set("app/routes/api.health.jsx", String.raw`import prisma from "../db.server";
import {jsonResponse} from "../lib/responses.server";

export async function loader() {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    return jsonResponse({status: "ok"});
  } catch {
    return jsonResponse({status: "unavailable"}, {status: 503});
  }
}
`);

for (const [path, content] of files) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, content, "utf8");
}
