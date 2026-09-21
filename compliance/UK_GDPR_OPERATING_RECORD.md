# Exdox UK GDPR operating record

Last reviewed: 21 September 2026

This internal record supports Exdox's day-to-day data-protection work. It is not a certification and must be reviewed whenever the service, suppliers, or data use changes.

## Roles and scope

- Exdox is the controller for account administration, billing status, security, support, business enquiries, and consent-based public-site analytics.
- A customer organisation is normally the controller for personal data it places in its Exdox workspace. Exdox is its processor for hosting, document extraction, workflow, reporting, and customer-directed integrations.
- The public Privacy Policy, Data Processing Agreement, Subprocessors page, Data Retention Policy, Cookie Policy, and Account Deletion page must remain consistent with the service.

## Processing record

| Activity | Main data | Data subjects | Purpose | Lawful basis / role | Recipient |
| --- | --- | --- | --- | --- | --- |
| Account and workspace administration | Name, email, organisation, role, access status | Customers and invited users | Provide and secure the service | Contract; legitimate interests; Exdox controller | AWS |
| Receipt, invoice, expense, and mileage workflows | Documents, extracted fields, transaction and journey details, approval activity | Customer staff, suppliers, customers, people named in documents | Provide requested workspace functions | Customer instructions; Exdox processor | AWS; OpenAI for assisted extraction |
| Billing | Billing contact, Stripe identifiers, subscription and invoice status | Workspace owners and billing contacts | Trial and subscription administration | Contract; legal obligation; Exdox controller | Stripe |
| Xero publication | Authorised accounting records and connection identifiers | Customer users and people represented in records | Customer-requested accounting integration | Customer instructions; Exdox processor | Xero |
| Support and security | Correspondence, account context, IP/device and security events | Users and enquirers | Support, fraud prevention, incident response | Contract; legitimate interests; legal obligation | AWS email and hosting services |
| Public-site analytics | Consent choice, device/browser and page interaction data | Website visitors | Measure and improve public pages | Consent | Google Analytics |

## Retention and deletion

- Active workspace data is retained while the service is active or until an authorised user deletes it.
- Recycle-bin content is scheduled for permanent removal after three days.
- Owner-confirmed account closure purges Exdox-hosted workspace records and stored object versions, deletes user access and settings, removes sales inbound-address token mappings, cancels billing, and requests deletion of the Stripe customer profile.
- Tax or accounting evidence may be retained for up to six years where a UK legal obligation applies.
- Support and privacy-request correspondence may be kept for up to 24 months after resolution when needed as evidence or for a dispute.
- Legal holds apply only to affected data and end when the need expires. Provider and isolated backup deletion follows the applicable provider lifecycle.

## Individual-rights process

1. Requests arrive through contact@exdox.co.uk or the website contact form and are logged with receipt date, scope, and owner.
2. Verify identity and authority proportionately. If the customer is the controller, notify it promptly and assist with its response.
3. Search the relevant account, workspace, support, billing, and integration records. Record any exemption or retention requirement.
4. Respond without undue delay and normally within one month. Record any lawful extension and notify the requester within the first month.
5. Complete agreed correction, export, restriction, objection, or deletion work and retain only the minimum evidence of the response.

## Incident process

1. Contain the incident, preserve necessary evidence, restrict access, and start an incident record.
2. Establish what data and people are affected, the likely consequences, and mitigations.
3. Notify an affected customer controller without undue delay where Exdox is its processor.
4. Where Exdox is controller, assess ICO notification promptly. Notify the ICO within 72 hours of awareness when the legal threshold is met and notify affected people when high risk requires it.
5. Record the decision, communications, remediation, and lessons even where notification is not required.

## Security and supplier controls

- Use least-privilege production access, strong authentication, encrypted transport and storage, password hashing, public-access blocking, environment-separated secrets, logging, and dependency maintenance.
- Review suppliers before use for purpose, location, confidentiality, security, deletion, incident support, and lawful international-transfer terms.
- Keep the published subprocessor list current and assess material changes before data is sent.
- Reassess the need for a data-protection impact assessment when introducing new high-risk monitoring, special-category data, large-scale profiling, or a material change in AI use.

## Owner actions that code cannot complete

- Confirm that the published controller identity, trading status, and contact details are legally complete. Add a service address if required after taking professional advice.
- Complete the ICO data-protection fee self-assessment under the actual legal owner and register/pay if required. Record the registration number and renewal date here once obtained.
- Keep signed supplier terms, transfer safeguards, data-processing terms, and risk reviews with this record.
- Arrange professional legal review before relying on the public terms and DPA for a material customer contract.
