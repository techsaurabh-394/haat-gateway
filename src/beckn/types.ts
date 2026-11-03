/**
 * The subset of Beckn core 1.2 / ONDC retail shapes this project uses.
 * Field names follow the ONDC retail API contract; only what the gateway reads is typed.
 */
export type BecknAction = 'search' | 'select' | 'init' | 'confirm' | 'status' | 'cancel';
export type BecknCallback = `on_${BecknAction}`;
export const CALLBACKS: BecknCallback[] = ['on_search', 'on_select', 'on_init', 'on_confirm', 'on_status', 'on_cancel'];

export type BecknContext = {
  domain: string; // e.g. ONDC:RET10
  country: string; // IND
  city: string; // std:0542 (Varanasi)
  action: BecknAction | BecknCallback;
  core_version: string; // 1.2.0
  bap_id: string;
  bap_uri: string;
  bpp_id?: string;
  bpp_uri?: string;
  transaction_id: string;
  message_id: string;
  timestamp: string;
  ttl: string; // ISO 8601 duration, e.g. PT30S
};

export type Price = { currency: 'INR'; value: string };

export type CatalogItem = {
  id: string;
  descriptor: { name: string; short_desc?: string; images?: string[] };
  price: Price;
  quantity: {
    unitized?: { measure: { unit: string; value: string } };
    available?: { count: string };
    maximum?: { count: string };
  };
  category_id?: string;
  tags?: Array<{ code: string; list: Array<{ code: string; value: string }> }>;
  '@ondc/org/returnable'?: boolean;
  '@ondc/org/cancellable'?: boolean;
};

export type Provider = {
  id: string;
  descriptor: { name: string; short_desc?: string };
  locations?: Array<{ id: string; address?: { locality?: string; city?: string; area_code?: string }; gps?: string }>;
  items: CatalogItem[];
};

export type Catalog = {
  'bpp/descriptor': { name: string };
  'bpp/providers': Provider[];
};

export type OrderItem = { id: string; quantity: { count: number } };

export type QuoteBreakup = {
  '@ondc/org/item_id': string;
  '@ondc/org/item_quantity'?: { count: number };
  '@ondc/org/title_type': 'item' | 'delivery' | 'packing' | 'tax' | 'discount';
  title: string;
  price: Price;
};

export type Quote = { price: Price; breakup: QuoteBreakup[]; ttl?: string };

export type Fulfillment = {
  id?: string;
  type?: 'Delivery';
  state?: { descriptor: { code: string } };
  '@ondc/org/TAT'?: string;
  end?: {
    location?: { gps?: string; address: Address };
    contact?: { phone: string; email?: string };
    person?: { name: string };
  };
};

export type Address = {
  name?: string;
  building?: string;
  street?: string;
  locality?: string;
  city: string;
  state: string;
  country?: string;
  area_code: string;
};

export type Payment = {
  type: 'ON-ORDER' | 'ON-FULFILLMENT' | 'PRE-FULFILLMENT';
  collected_by: 'BAP' | 'BPP';
  status?: 'PAID' | 'NOT-PAID';
  uri?: string;
  params?: { amount: string; currency: 'INR' };
};

export type Order = {
  id?: string;
  state?: string;
  provider: { id: string; descriptor?: { name: string }; locations?: Array<{ id: string }> };
  items: OrderItem[];
  billing?: { name: string; phone: string; address: Address; email?: string };
  fulfillments?: Fulfillment[];
  quote?: Quote;
  payment?: Payment;
  cancellation?: { cancelled_by: string; reason?: { id: string } };
  created_at?: string;
  updated_at?: string;
};

export type BecknMessage = {
  intent?: {
    item?: { descriptor?: { name?: string } };
    fulfillment?: { type?: string; end?: { location?: { gps?: string; address?: { area_code?: string } } } };
  };
  catalog?: Catalog;
  order?: Order;
  order_id?: string;
  cancellation_reason_id?: string;
};

export type BecknEnvelope = { context: BecknContext; message: BecknMessage; error?: { type?: string; code: string; message?: string } };

export const ACK = { message: { ack: { status: 'ACK' } } };
export const nack = (code: string, message: string) => ({
  message: { ack: { status: 'NACK' } },
  error: { type: 'CONTEXT-ERROR', code, message },
});
