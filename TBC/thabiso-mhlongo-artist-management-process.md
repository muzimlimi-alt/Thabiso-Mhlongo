# Thabiso Mhlongo Artist Booking & Management Portal

This document captures the public booking flow, private management workflow, and the key back-office screen layouts for Thabiso Mhlongo, managed by Muzi Mlimi.

## 1. Roles

- **Artist:** Thabiso Mhlongo
- **Manager:** Muzi Mlimi
- **Client:** A person or company booking Thabiso through the public website
- **Venue/Promoter:** Optional third party involved in the event

## 2. System Overview

The system has two sides:

- **Public-facing website** where clients can discover Thabiso and submit booking requests.
- **Private management portal** where Muzi reviews requests, builds offers, manages contracts, sends invoices, prepares advancing packs, and tracks performance outcomes.

## 3. Public Booking Journey

### 3.1 Where it starts

The client visits Thabiso’s website and opens the **Book Thabiso** page.

### 3.2 Booking request form fields

#### Client details
- Full name
- Company / organization
- Email
- Phone / WhatsApp
- Country and city

#### Event details
- Event type: Corporate, Festival, Club, Private function, TV, Radio, Other
- Event name
- Preferred date(s)
- Alternative dates
- Venue name and address
- Expected audience size
- Audience profile

#### Performance and budget
- Desired set length: 30 / 45 / 60 minutes or custom
- Content notes: e.g. corporate-safe, no explicit material
- Estimated budget or fee range
- How they heard about Thabiso

#### Additional info
- MC services needed
- Travel / accommodation needed
- Open notes field
- Consent checkbox

### 3.3 Client confirmation

After submission, the client sees a confirmation message and receives an auto-email acknowledging receipt.

### 3.4 Back-office creation

A booking request is created in the private portal and assigned a status such as **New Inquiry**.

## 4. Private Management Workflow

### 4.1 Booking request review

Muzi opens the request in the portal, checks the details, and decides whether the booking is a fit.

Possible outcomes:
- Proceed to a deal
- Ask for more information
- Decline politely
- Archive the request

### 4.2 Deal creation

If the request is valid, Muzi converts it into a **Deal**.

Core deal fields:
- Artist
- Client
- Event name
- Event type
- Date
- Venue
- City
- Set length
- Budget
- Status

### 4.3 Offer creation

Muzi creates an offer based on the deal.

Offer fields:
- Date and time
- Venue
- Fee
- Deposit terms
- Balance terms
- Travel terms
- Technical summary
- Offer expiry date

Possible outcomes:
- Client accepts
- Client requests changes
- Client does not respond and the offer expires

### 4.4 Contract creation

Once the offer is accepted, Muzi generates a contract.

Contract includes:
- Parties
- Performance details
- Fee and payment terms
- Cancellation terms
- Travel and accommodation terms
- Technical rider reference
- Recording rights
- Signature fields

### 4.5 Invoicing and payment

Muzi sends:
- Deposit invoice
- Balance invoice

The portal tracks:
- Sent
- Paid
- Overdue
- Partially paid

### 4.6 Advancing

Muzi prepares the advancing pack, which includes:
- Run-of-show
- Technical requirements
- Hospitality needs
- Contacts
- Travel information
- Notes

### 4.7 Show day

On the event day:
- Load-in happens
- Soundcheck happens
- Thabiso performs
- Settlement is confirmed
- The balance is paid if still outstanding

### 4.8 Closeout

After the show, the deal is marked completed and Muzi may add notes, testimonials, and follow-up tasks.

## 5. Workflow Stages

### Main sequence

Inquiry → Review → Deal → Offer → Negotiation → Hold → Contract Signed → Deposit Paid → Advancing → Pre-show Confirmation → Show Day → Settlement → Balance Paid → Completed

### Possible branch outcomes

- Declined
- Offer expired
- Negotiation failed
- Hold released
- Contract not signed
- Deposit unpaid
- Client cancellation
- Artist cancellation
- Disputed settlement
- Fully paid and completed

## 6. Screen Layouts

## 6.1 Booking Request Detail

### Purpose
Show all form data from the public booking request and let Muzi convert, decline, or archive it.

### Header
- Breadcrumb: Booking Requests > Request Name
- Title: Event title
- Status badge
- Primary actions: Convert to Deal, Mark as Not a Fit, Archive

### Main content

#### Left column: client and event info
- Client details
- Event details
- Performance and budget
- Additional info

#### Right column: meta and actions
- Submitted date and source
- Tags
- Activity timeline
- Internal notes
- Quick actions

## 6.2 Deal View

### Purpose
The main hub for managing the full booking lifecycle.

### Header
- Breadcrumb
- Deal title
- Status badge
- Summary chips for date, city, fee, deposit
- Actions: Create Offer, Create Contract, Create Invoice, More

### Tabs
- Overview
- Offer & Contract
- Invoices & Payments
- Advancing
- Timeline & Notes
- Files

### Overview tab
- Deal summary
- Financial snapshot
- Calendar preview
- Quick contacts

### Offer & Contract tab
- Offer versions list
- Contract status and documents

### Invoices & Payments tab
- Invoice list
- Payment records

### Advancing tab
- Advancing pack status
- Run-of-show summary
- Tech and hospitality summary
- Contacts

### Timeline & Notes tab
- Full activity log
- Internal notes thread
- Communication history

### Files tab
- Offer PDFs
- Contract PDFs
- Invoices
- POP files
- Other attachments

## 6.3 Offer Builder

### Purpose
Create a professional booking offer from the deal.

### Main sections
- Basic info
- Performance details
- Fee and payment terms
- Travel and accommodation
- Technical summary
- Offer validity and notes
- Template and preview

### Sidebar
- Deal context
- Version info

### Actions
- Save Draft
- Preview PDF
- Send Offer

## 6.4 Contract Builder

### Purpose
Generate a formal performance agreement from the accepted offer.

### Main sections
- Parties
- Performance details
- Fee and payment
- Cancellation and force majeure
- Travel, accommodation, and hospitality
- Technical requirements
- Rights and recording
- Additional clauses
- Templates and options
- E-signature settings

### Sidebar
- Offer reference
- Document outline

### Actions
- Save Draft
- Preview PDF
- Send for Signature

## 6.5 Advancing Pack

### Purpose
Prepare the detailed show plan shared with the client, venue, and artist.

### Tabs
- Run-of-Show
- Technical
- Hospitality
- Contacts
- Travel & Accommodation
- Notes & Attachments

### Run-of-show section
- Editable timeline rows
- Add, delete, and reorder events

### Technical section
- Mic type
- PA
- Monitors
- Lighting
- Stage layout
- Equipment responsibility

### Hospitality section
- Green room needs
- Meals
- Dietary requirements
- Parking / Wi-Fi / changing area

### Contacts section
- Client
- Venue tech
- Stage manager
- Artist
- Manager
- Driver

### Travel & accommodation section
- Local or out-of-town details
- Flights
- Hotel
- Ground transport

### Notes & attachments
- Internal notes
- Files
- Version history

### Actions
- Save Draft
- Preview PDF
- Send to Client & Venue
- Mark as Confirmed

## 7. Example Scenario

### Client request

Thandi Nkosi from TechCorp SA submits a booking request for a corporate year-end event in Johannesburg.

### Muzi’s response

Muzi reviews the request, confirms availability, creates an offer, negotiates if needed, sends a contract, collects deposit, prepares the advancing pack, and tracks the performance through completion.

### Outcome

Thabiso performs successfully, settlement is confirmed, the balance is paid, and the deal is closed.

## 8. Recommended Data Objects

- BookingRequest
- Deal
- Offer
- Contract
- Invoice
- Payment
- AdvancingPack
- TimelineEvent
- InternalNote
- FileAttachment

## 9. Suggested Status Values

### Booking Request
- New Inquiry
- In Review
- Converted
- Not a Fit
- Archived

### Deal
- Inquiry
- Offer Sent
- Offer Accepted
- Hold
- Contract Sent
- Contract Signed
- Confirmed
- Deposit Paid
- Advancing
- Completed
- Cancelled
- Disputed

### Invoice
- Draft
- Sent
- Paid
- Overdue
- Cancelled

## 10. Notes

This document is written as a product and operations reference for building a real artist-management website and back-office portal. It can be used as a foundation for design, development, and process documentation.