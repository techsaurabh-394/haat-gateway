/** OpenAPI 3.1 description, listed in poppy.json under `apis` (spec section 7). */
export function openapi(publicUrl: string, issuer?: string): Record<string, unknown> {
  const session = { $ref: '#/components/parameters/PoppySession' };
  const err = (d: string) => ({ description: d, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
  return {
    openapi: '3.1.0',
    info: {
      title: 'Haat gateway API',
      version: '0.1.0',
      description:
        'Search sellers on the ONDC network and place orders for a User. Every order and cancellation needs the User\'s approval through the Poppy Operations extension (version 2). All requests carry a Poppy-Session header. Signed-out Sessions only in this version.',
      license: { name: 'MIT' },
    },
    servers: [{ url: publicUrl }],
    paths: {
      '/api/v1/search': {
        get: {
          operationId: 'search',
          summary: 'Search nearby sellers for a shopping list typed in English, Hinglish or Hindi',
          parameters: [
            session,
            { name: 'q', in: 'query', required: true, schema: { type: 'string', maxLength: 300 }, example: '2 kilo atta aur 1 litre doodh' },
            { name: 'city', in: 'query', schema: { type: 'string' }, example: 'std:0542', description: 'ONDC city code (std:<STD code>). Defaults to the gateway city.' },
          ],
          responses: { '200': { description: 'Parsed items, offers and a suggested single-seller basket' }, '400': err('Invalid request or Session') },
        },
      },
      '/api/v1/orders': {
        get: { security: [{}, { poppy: ['orders:read'] }], operationId: 'listOrders', summary: "List this User's orders", parameters: [session], responses: { '200': { description: 'Orders' } } },
        post: {
          operationId: 'placeOrder',
          summary: 'Place an order (returns approval_required first)',
          description:
            'The first call returns HTTP 403 with error approval_required and an operation. Show operation.summary to the User; if they approve, send the same request again with the Poppy-Approval header. The order is placed at most once.',
          parameters: [session, { $ref: '#/components/parameters/PoppyApproval' }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Cart' } } } },
          responses: {
            '201': { description: 'Order placed' },
            '403': err('approval_required (body has operation) or extension_required'),
            '503': { description: 'Order outcome not known yet; retry with the same approval after Retry-After seconds' },
          },
        },
      },
      '/api/v1/orders/{id}': {
        get: { operationId: 'getOrder', summary: 'Order status from the seller', parameters: [session, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Order' }, '404': err('order_not_found') } },
      },
      ...(issuer
        ? {
            '/api/v1/account/addresses': {
              get: { operationId: 'listAddresses', summary: 'Saved delivery addresses', parameters: [session], security: [{ poppy: ['addresses'] }], responses: { '200': { description: 'Addresses' }, '401': { description: 'Sign-in needed' } } },
              post: { operationId: 'addAddress', summary: 'Save a delivery address', parameters: [session], security: [{ poppy: ['addresses'] }], responses: { '201': { description: 'Saved' } } },
            },
            '/api/v1/account/addresses/{id}': {
              delete: { operationId: 'deleteAddress', summary: 'Delete a saved address', parameters: [session, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }], security: [{ poppy: ['addresses'] }], responses: { '204': { description: 'Deleted' } } },
            },
          }
        : {}),
      '/api/v1/orders/{id}/cancel': {
        post: {
          operationId: 'cancelOrder',
          summary: 'Cancel an order (needs approval)',
          parameters: [session, { $ref: '#/components/parameters/PoppyApproval' }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Cancelled' }, '403': err('approval_required'), '409': err('seller refused, e.g. already out for delivery') },
        },
      },
    },
    components: {
      parameters: {
        PoppySession: { name: 'Poppy-Session', in: 'header', required: true, schema: { type: 'string' }, description: 'Session JWT (Personal Agent Protocol draft 0.3, section 5.2)' },
        PoppyApproval: { name: 'Poppy-Approval', in: 'header', required: false, schema: { type: 'string' }, example: 'operation_id="op_x", revision="1790000000-abc"' },
      },
      ...(issuer
        ? {
            securitySchemes: {
              poppy: {
                type: 'oauth2',
                description: 'Optional. Signed out, orders are guest orders in this Session. Signed in, they belong to the account.',
                flows: {
                  authorizationCode: {
                    authorizationUrl: `${issuer}/oauth/authorize`,
                    tokenUrl: `${issuer}/oauth/token`,
                    refreshUrl: `${issuer}/oauth/token`,
                    scopes: {
                      'orders:read': 'See your orders and their delivery status',
                      'orders:write': 'Place and cancel orders in your account (each one still needs your approval)',
                      addresses: 'See and change your saved delivery addresses',
                    },
                  },
                },
              },
            },
          }
        : {}),
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' }, error_description: { type: 'string' }, operation: { type: 'object' } }, required: ['error'] },
        Cart: {
          type: 'object',
          required: ['bpp_id', 'provider_id', 'items'],
          description: 'Give either delivery, or (signed in with the addresses scope) delivery_address_id.',
          properties: {
            delivery_address_id: { type: 'string' },
            bpp_id: { type: 'string' },
            provider_id: { type: 'string' },
            items: { type: 'array', items: { type: 'object', required: ['id', 'count'], properties: { id: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 100 } } } },
            delivery: {
              type: 'object',
              required: ['name', 'phone', 'address'],
              properties: {
                name: { type: 'string' },
                phone: { type: 'string', pattern: '^[6-9][0-9]{9}$' },
                gps: { type: 'string', example: '25.2677,82.9913' },
                address: {
                  type: 'object',
                  required: ['city', 'state', 'area_code'],
                  properties: { building: { type: 'string' }, street: { type: 'string' }, locality: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, area_code: { type: 'string', pattern: '^[1-9][0-9]{5}$' } },
                },
              },
            },
          },
        },
      },
    },
  };
}
