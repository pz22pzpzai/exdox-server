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
  - Route scaffolded for future auth migration. No implementation exists in the current repo.

## Files added for migration

- `infra/template.yaml`
  - AWS SAM template for API Gateway, Lambda, and private S3 bucket setup.
- `schema/001_exdox.sql`
  - Initial MySQL schema for receipts storage in RDS.
- `src/aws/**`
  - Lambda handlers and shared modules for S3, RDS, and OpenAI processing.
- `src/scripts/applySchema.ts`
  - Applies the schema to an RDS instance once credentials are available.

## Owner-gated steps still required

1. AWS Console login and IAM user creation
2. RDS instance creation with owner-entered master credentials
3. Final selection of VPC subnets and security groups for Lambda-to-RDS connectivity
4. Deployment of the SAM stack with real AWS account parameters
5. Mobile app base URL swap to the final API Gateway URL
