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
