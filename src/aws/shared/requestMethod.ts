type RequestMethodEvent = {
  requestContext?: {
    http?: {
      method?: string;
    };
  };
  httpMethod?: string;
};

export function resolveRequestMethod(event: RequestMethodEvent) {
  return (event.requestContext?.http?.method ?? event.httpMethod ?? '').toUpperCase();
}
