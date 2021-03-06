import {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response
} from "express";

import * as msRest from "@azure/ms-rest-js";

import ILogger from "../../common/ILogger";
import StorageErrorFactory from "../errors/StorageErrorFactory";
import * as Mappers from "../generated/artifacts/mappers";
import Specifications from "../generated/artifacts/specifications";
import MiddlewareError from "../generated/errors/MiddlewareError";
import IQueueMetadataStore from "../persistence/IQueueMetadataStore";
import { HeaderConstants } from "../utils/constants";

export default class PreflightMiddlewareFactory {
  constructor(private readonly logger: ILogger) {}

  public createOPTIONSHandlerMiddleware(
    metadataStore: IQueueMetadataStore
  ): ErrorRequestHandler {
    return (
      err: MiddlewareError | Error,
      req: Request,
      res: Response,
      next: NextFunction
    ) => {
      if (req.method === "OPTIONS") {
        this.logger.info(`preflightMiddleware: Get an option request.`);

        const requestId = res.locals.azurite_queue_context.contextID;
        const account = res.locals.azurite_queue_context.account;

        const originHeader = HeaderConstants.ORIGIN;
        const origin = req.headers[originHeader] as string;
        if (origin === undefined) {
          return next(
            StorageErrorFactory.getInvalidCorsHeaderValue(requestId, {
              MessageDetails: "Missing required CORS header Origin"
            })
          );
        }

        const requestMethod = req.headers[
          HeaderConstants.ACCESS_CONTROL_REQUEST_METHOD
        ] as string;
        if (requestMethod === undefined) {
          return next(
            StorageErrorFactory.getInvalidCorsHeaderValue(requestId, {
              MessageDetails:
                "Missing required CORS header Access-Control-Request-Method"
            })
          );
        }

        const requestHeaders = req.headers[
          HeaderConstants.ACCESS_CONTROL_REQUEST_HEADERS
        ] as string;

        metadataStore
          .getServiceProperties(account)
          .then(properties => {
            if (properties === undefined || properties.cors === undefined) {
              return next(
                StorageErrorFactory.corsPreflightFailure(requestId, {
                  MessageDetails: "No CORS rules matches this request"
                })
              );
            }
            const corsSet = properties!.cors!;

            for (const cors of corsSet) {
              if (
                !this.checkOrigin(origin, cors.allowedOrigins) ||
                !this.checkMethod(requestMethod, cors.allowedMethods)
              ) {
                continue;
              }
              if (
                requestHeaders !== undefined &&
                !this.checkHeaders(requestHeaders, cors.allowedHeaders)
              ) {
                continue;
              }

              res.setHeader(
                HeaderConstants.ACCESS_CONTROL_ALLOW_ORIGIN,
                origin
              );
              res.setHeader(
                HeaderConstants.ACCESS_CONTROL_ALLOW_METHODS,
                requestMethod
              );
              if (requestHeaders !== undefined) {
                res.setHeader(
                  HeaderConstants.ACCESS_CONTROL_ALLOW_METHODS,
                  requestHeaders
                );
              }
              res.setHeader(
                HeaderConstants.ACCESS_CONTROL_MAX_AGE,
                cors.maxAgeInSeconds
              );
              res.setHeader(
                HeaderConstants.ACCESS_CONTROL_ALLOW_CREDENTIALS,
                "true"
              );

              return next();
            }
            return next(
              StorageErrorFactory.corsPreflightFailure(requestId, {
                MessageDetails: "No CORS rules matches this request"
              })
            );
          })
          .catch(next);
      } else {
        next(err);
      }
    };
  }

  public createActualCorsRequestMiddleware(
    metadataStore: IQueueMetadataStore
  ): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      if (req.method === "OPTIONS") {
        return next();
      }

      // const requestId = res.locals.azurite_queue_context.contextID;
      const account = res.locals.azurite_queue_context.account;

      const originHeader = HeaderConstants.ORIGIN;
      const origin = req.headers[originHeader] as string | undefined;

      metadataStore
        .getServiceProperties(account)
        .then(properties => {
          if (properties === undefined || properties.cors === undefined) {
            return next();
          }
          const corsSet = properties!.cors!;
          const resHeaders = this.getResponseHeaders(res);

          for (const cors of corsSet) {
            if (this.checkOrigin(origin, cors.allowedOrigins)) {
              const exposedHeaders = this.getExposedHeaders(
                resHeaders,
                cors.exposedHeaders
              );

              res.setHeader(
                HeaderConstants.ACCESS_CONTROL_EXPOSED_HEADER,
                exposedHeaders
              );

              res.setHeader(
                HeaderConstants.ACCESS_CONTROL_ALLOW_ORIGIN,
                cors.allowedOrigins
              );
              if (cors.allowedOrigins !== "*") {
                res.setHeader(HeaderConstants.VARY, "Origin");
                res.setHeader(
                  HeaderConstants.ACCESS_CONTROL_ALLOW_CREDENTIALS,
                  "true"
                );
              }

              return next();
            }
          }
          if (corsSet.length > 0) {
            res.setHeader(HeaderConstants.VARY, "Origin");
          }
          return next();
        })
        .catch(next);
    };
  }

  private checkOrigin(
    origin: string | undefined,
    allowedOrigin: string
  ): boolean {
    if (allowedOrigin === "*") {
      return true;
    }
    if (origin === undefined) {
      return false;
    }
    const allowedOriginArray = allowedOrigin.split(",");
    for (const corsOrigin of allowedOriginArray) {
      if (origin.trimLeft().trimRight() === corsOrigin.trimLeft().trimRight()) {
        return true;
      }
    }
    return false;
  }

  private checkMethod(method: string, allowedMethod: string): boolean {
    const allowedMethodArray = allowedMethod.split(",");
    for (const corsMethod of allowedMethodArray) {
      if (method.trimLeft().trimRight() === corsMethod.trimLeft().trimRight()) {
        return true;
      }
    }
    return false;
  }

  private checkHeaders(headers: string, allowedHeaders: string): boolean {
    const headersArray = headers.split(",");
    const allowedHeadersArray = allowedHeaders.split(",");
    for (const header of headersArray) {
      let flag = false;
      const trimedHeader = header
        .trimLeft()
        .trimRight()
        .toLowerCase();

      for (const allowedHeader of allowedHeadersArray) {
        // TODO: Should remove the wrapping blank when set CORS through set properties for service.
        const trimedAllowedHeader = allowedHeader
          .trimLeft()
          .trimRight()
          .toLowerCase();
        if (
          trimedHeader === trimedAllowedHeader ||
          (trimedAllowedHeader[trimedAllowedHeader.length - 1] === "*" &&
            trimedHeader.startsWith(
              trimedAllowedHeader.substr(0, trimedAllowedHeader.length - 1)
            ))
        ) {
          flag = true;
          break;
        }
      }

      if (flag === false) {
        return false;
      }
    }

    return true;
  }

  private getResponseHeaders(res: Response): string[] {
    const handlerResponse = res.locals.azurite_queue_context.handlerResponses;
    const statusCodeInResponse: number = handlerResponse.statusCode;
    const spec = Specifications[res.locals.azurite_queue_context.operation];
    const responseSpec = spec.responses[statusCodeInResponse];
    if (!responseSpec) {
      throw new TypeError(
        `Request specification doesn't include provided response status code`
      );
    }

    // Serialize headers
    const headerSerializer = new msRest.Serializer(Mappers);
    const headersMapper = responseSpec.headersMapper;

    const responseHeaderSet = [];
    if (headersMapper && headersMapper.type.name === "Composite") {
      const mappersForAllHeaders = headersMapper.type.modelProperties || {};

      // Handle headerMapper one by one
      for (const key in mappersForAllHeaders) {
        if (mappersForAllHeaders.hasOwnProperty(key)) {
          const headerMapper = mappersForAllHeaders[key];
          const headerName = headerMapper.serializedName;
          const headerValueOriginal = handlerResponse[key];
          const headerValueSerialized = headerSerializer.serialize(
            headerMapper,
            headerValueOriginal
          );

          // Handle collection of headers starting with same prefix, such as x-ms-meta prefix
          const headerCollectionPrefix = (headerMapper as msRest.DictionaryMapper)
            .headerCollectionPrefix;
          if (
            headerCollectionPrefix !== undefined &&
            headerValueOriginal !== undefined
          ) {
            for (const collectionHeaderPartialName in headerValueSerialized) {
              if (
                headerValueSerialized.hasOwnProperty(
                  collectionHeaderPartialName
                )
              ) {
                const collectionHeaderValueSerialized =
                  headerValueSerialized[collectionHeaderPartialName];
                const collectionHeaderName = `${headerCollectionPrefix}${collectionHeaderPartialName}`;
                if (
                  collectionHeaderName &&
                  collectionHeaderValueSerialized !== undefined
                ) {
                  responseHeaderSet.push(collectionHeaderName);
                }
              }
            }
          } else {
            if (headerName && headerValueSerialized !== undefined) {
              responseHeaderSet.push(headerName);
            }
          }
        }
      }
    }

    if (
      spec.isXML &&
      responseSpec.bodyMapper &&
      responseSpec.bodyMapper.type.name !== "Stream"
    ) {
      responseHeaderSet.push("content-type");
      responseHeaderSet.push("content-length");
    } else if (
      handlerResponse.body &&
      responseSpec.bodyMapper &&
      responseSpec.bodyMapper.type.name === "Stream"
    ) {
      responseHeaderSet.push("content-length");
    }

    const headers = res.getHeaders();
    for (const header in headers) {
      if (typeof header === "string") {
        responseHeaderSet.push(header);
      }
    }

    // TODO: Should extract the header by some policy.
    // or apply a referred list indicates the related headers.
    responseHeaderSet.push("Date");
    responseHeaderSet.push("Connection");
    responseHeaderSet.push("Transfer-Encoding");

    return responseHeaderSet;
  }

  private getExposedHeaders(
    responseHeaders: any,
    exposedHeaders: string
  ): string {
    const exposedHeaderRules = exposedHeaders.split(",");
    const prefixRules = [];
    const simpleHeaders = [];
    for (let i = 0; i < exposedHeaderRules.length; i++) {
      exposedHeaderRules[i] = exposedHeaderRules[i].trimLeft().trimRight();
      if (exposedHeaderRules[i].endsWith("*")) {
        prefixRules.push(
          exposedHeaderRules[i]
            .substr(0, exposedHeaderRules[i].length - 1)
            .toLowerCase()
        );
      } else {
        simpleHeaders.push(exposedHeaderRules[i]);
      }
    }

    const resExposedHeaders: string[] = [];
    for (const header of responseHeaders) {
      let isMatch = false;
      for (const rule of prefixRules) {
        if (header.toLowerCase().startsWith(rule)) {
          isMatch = true;
          break;
        }
      }
      if (!isMatch) {
        for (const simpleHeader of simpleHeaders) {
          if (header.toLowerCase() === simpleHeader.toLowerCase()) {
            isMatch = true;
            break;
          }
        }
      }

      if (isMatch) {
        resExposedHeaders.push(header);
      }
    }

    for (const simpleHeader of simpleHeaders) {
      let isMatch = false;
      for (const header of resExposedHeaders) {
        if (simpleHeader.toLowerCase() === header.toLowerCase()) {
          isMatch = true;
          break;
        }
      }
      if (!isMatch) {
        resExposedHeaders.push(simpleHeader);
      }
    }

    return resExposedHeaders.join(",");
  }
}
