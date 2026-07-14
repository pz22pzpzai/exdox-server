# exdox AWS Migration Notes

## Current evidence

- The repository currently contains a single Express OCR backend in [src/index.ts](./src/index.ts).
- The mobile app currently calls the VPS OCR endpoint directly.
- A MariaDB server exists on the VPS, but there is no app-specific non-system schema present today.

## Serverless target shape

- `POST /upload/presign`
  - Returns an S3 presigned upload URL for private receipt storage.
- `POST /api/v1/expenses/process`
  - Legacy-compatible route for the current mobile app.
  - Accepts multipart file upload, saves the file into S3, runs OpenAI extraction, writes the result into RDS, and returns structured JSON.
- `POST /receipts/process`
  - Serverless-native processing route that accepts an `s3Key` after a direct S3 upload.
- `GET /receipts`
  - Lists stored receipt rows from RDS.
- `POST /login`
  - Authenticates active users and returns the JWT used by the mobile and web clients.

## Files added for migration

- `infra/template.yaml`
  - AWS SAM template for API Gateway, Lambda, and private S3 bucket setup.
- `schema/001_exdox.sql`
  - Initial MySQL schema for receipts storage in RDS.
- `src/aws/**`
  - Lambda handlers and shared modules for S3, RDS, and OpenAI processing.
- `src/scripts/applySchema.ts`
  - Applies the schema to an RDS instance once credentials are available.

## Production deployment checks

The production SAM stack is `receiptflow-expenses-prod` in `eu-west-2`. It is currently
configured with `ReceiptStoreMode=s3`.

After every stack or Lambda code deployment, smoke-test all three paths before treating
the release as complete:

1. `GET /health` returns `200`.
2. `POST /login` with deliberately invalid credentials returns `401 invalid_credentials`,
   rather than `500` or an API Gateway error.
3. A protected receipt route without a token returns `401 unauthorized`.

On 2026-07-09 the production functions were restored after an incomplete Lambda package
caused `Runtime.ImportModuleError` on login. Ensure deployed packages retain the compiled
`dist/aws/handlers` directory and dependencies at the paths expected by `infra/template.yaml`.

## 2026-07-10 database hardening note

- Live RDS instance `receiptflow-mysql` was hardened in-place to set `PubliclyAccessible=false`
  and enable IAM database authentication.
- RDS security group `receiptflow-rds-sg` was reduced to MySQL ingress from only
  Lambda security group `receiptflow-lambda-sg`.
- Inline IAM policy `receiptflow-rds-iam-auth-connect` was added to the live Lambda execution roles
  to allow `rds-db:connect`.
- A local rollback snapshot of the pre-change state was saved at
  `C:\Users\User\OneDrive\Documents\Expenses App\server\aws-db-hardening-prechange-2026-07-10.json`.
- Private subnets, a private route table, and RDS subnet group `receiptflow-db-private-subnets`
  were created for future isolation work.
- Important limitation: RDS rejected an in-place move from subnet group `receiptflow-db-subnets`
  to `receiptflow-db-private-subnets` with `InvalidVPCNetworkStateFault`, so a full cutover
  to private subnets will likely require restoring or replacing the DB into the private subnet group,
  not just modifying the existing instance.
- Important Lambda networking limitation: the live Lambda functions are still not attached
  to VPC subnets because this VPC currently has no NAT gateway. Attaching them directly would
  break outbound calls such as OpenAI unless NAT or another outbound path is added first.

## 2026-07-14 vault encryption hardening note

- The live Vault/receipt S3 bucket `receiptflow-expenses-prod-025627371571-eu-west-2`
  now explicitly enforces AES-256 server-side encryption for object writes:
  - default bucket encryption remains `AES256`
  - the bucket policy now denies any `s3:PutObject` request that omits
    `x-amz-server-side-encryption`
  - the bucket policy also denies `s3:PutObject` requests whose encryption header is not `AES256`
- The shared server S3 helper now sends `ServerSideEncryption: AES256` on:
  - direct Lambda object uploads
  - JSON metadata writes
  - presigned upload URL generation
- The live API Gateway REST API `hz2zkm6jkf` is no longer on the legacy TLS profile:
  - `securityPolicy` is now `SecurityPolicy_TLS12_PFS_2025_EDGE`
  - `endpointAccessMode` is now `STRICT`
  - this satisfies the `TLS 1.2 or higher` requirement for the public execute-api endpoint
- The live RDS instance `receiptflow-mysql` was already encrypted at rest before this pass:
  - `StorageEncrypted=true`
  - KMS key ARN is present on the instance
- A dedicated custom DB parameter group now enforces encrypted transport on the DB side:
  - parameter group: `receiptflow-mysql-require-secure-transport`
  - `require_secure_transport=1`
  - `tls_version=TLSv1.2,TLSv1.3`
  - the instance was rebooted once so the parameter group is now `in-sync`
- The shared MySQL connection code in `src/aws/shared/db.ts` now always requests TLS 1.2+
  whenever MySQL mode is used, not only when IAM database authentication is enabled.
