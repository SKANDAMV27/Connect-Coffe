package db

import (
	"context"
	"time"
)

// DeliveryCounts is where each contact an offer went to stands, as far as
// Meta has told us. Sent is everyone it went to; the rest are subsets.
type DeliveryCounts struct {
	Sent      int `json:"sent"`
	Delivered int `json:"delivered"` // includes read
	Read      int `json:"read"`
	Failed    int `json:"failed"`
	// Not sent: over Meta's daily limit, or above the number chosen. A
	// retry sends to them.
	Skipped int `json:"skipped"`
	// Paid template messages that arrived: what Meta charges for.
	PaidDelivered int `json:"paid_delivered"`
}

type Recipient struct {
	Phone     string    `json:"phone"`
	Name      string    `json:"name"`
	Channel   string    `json:"channel"`
	Status    string    `json:"status"`
	ErrorCode int       `json:"error_code"`
	Error     string    `json:"error"`
	SentAt    time.Time `json:"sent_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// RecordRecipient notes one send of a campaign. waID is empty when Meta
// refused the send outright, in which case errCode and errMsg say why.
func RecordRecipient(campaignID int, phone, channel, waID string, errCode int, errMsg string) error {
	status := "sent"
	if waID == "" {
		status = "failed"
	}
	return recordRecipient(campaignID, phone, channel, waID, status, errCode, errMsg)
}

// RecordSkipped notes a contact the campaign held back, and why.
func RecordSkipped(campaignID int, phone, channel, reason string) error {
	return recordRecipient(campaignID, phone, channel, "", "skipped", 0, reason)
}

func recordRecipient(campaignID int, phone, channel, waID, status string, errCode int, errMsg string) error {
	_, err := Pool.Exec(context.Background(),
		`INSERT INTO campaign_recipients (campaign_id, phone, channel, wa_msg_id, status, error_code, error)
		 VALUES ($1, $2, $3, NULLIF($4, ''), $5, NULLIF($6, 0), NULLIF($7, ''))`,
		campaignID, phone, channel, waID, status, errCode, errMsg)
	return err
}

// UpdateRecipientStatus applies a status webhook. Meta's statuses can arrive
// out of order (read before delivered), so a row only moves forward; failed
// is final. Messages that are not part of a campaign match no row.
func UpdateRecipientStatus(waID, status string, errCode int, errMsg string) error {
	_, err := Pool.Exec(context.Background(),
		`UPDATE campaign_recipients
		 SET status = $2, error_code = NULLIF($3, 0), error = NULLIF($4, ''), updated_at = NOW()
		 WHERE wa_msg_id = $1
		   AND (CASE status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END)
		     < (CASE $2 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END)`,
		waID, status, errCode, errMsg)
	return err
}

// GetDeliveryCounts returns the counts for each of the given campaigns.
// A campaign sent before delivery was tracked is missing from the map.
func GetDeliveryCounts(campaignIDs []int) (map[int]DeliveryCounts, error) {
	out := map[int]DeliveryCounts{}
	if len(campaignIDs) == 0 {
		return out, nil
	}
	rows, err := Pool.Query(context.Background(),
		`SELECT campaign_id,
		        COUNT(*) FILTER (WHERE status <> 'skipped'),
		        COUNT(*) FILTER (WHERE status IN ('delivered', 'read')),
		        COUNT(*) FILTER (WHERE status = 'read'),
		        COUNT(*) FILTER (WHERE status = 'failed'),
		        COUNT(*) FILTER (WHERE status = 'skipped'),
		        COUNT(*) FILTER (WHERE channel = 'template' AND status IN ('delivered', 'read'))
		 FROM campaign_recipients WHERE campaign_id = ANY($1)
		 GROUP BY campaign_id`, campaignIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		var c DeliveryCounts
		if err := rows.Scan(&id, &c.Sent, &c.Delivered, &c.Read, &c.Failed, &c.Skipped, &c.PaidDelivered); err != nil {
			return nil, err
		}
		out[id] = c
	}
	return out, rows.Err()
}

// GetRecipients lists everyone a campaign went to, failures first.
func GetRecipients(campaignID int) ([]Recipient, error) {
	rows, err := Pool.Query(context.Background(),
		`SELECT r.phone, COALESCE(c.name, ''), r.channel, r.status,
		        COALESCE(r.error_code, 0), COALESCE(r.error, ''), r.sent_at, r.updated_at
		 FROM campaign_recipients r
		 LEFT JOIN LATERAL (
		     SELECT name FROM contacts WHERE RIGHT(phone, 10) = RIGHT(r.phone, 10) LIMIT 1
		 ) c ON TRUE
		 WHERE r.campaign_id = $1
		 ORDER BY (r.status IN ('failed', 'skipped')) DESC, r.status, r.phone`, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Recipient{}
	for rows.Next() {
		var r Recipient
		if err := rows.Scan(&r.Phone, &r.Name, &r.Channel, &r.Status,
			&r.ErrorCode, &r.Error, &r.SentAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		list = append(list, r)
	}
	return list, rows.Err()
}

// ErrorStoppedMarketing is Meta's code for a person who turned off marketing
// messages from the cafe. A retry leaves them alone.
const ErrorStoppedMarketing = 131050

// GetRetryPhones returns the contacts a campaign failed to reach, or held
// back, that a retry may try again: still subscribed, and not ones who asked
// WhatsApp to stop the cafe's marketing. Never-sent ones come first.
func GetRetryPhones(campaignID int) ([]string, error) {
	rows, err := Pool.Query(context.Background(),
		`SELECT r.phone
		 FROM campaign_recipients r
		 WHERE r.campaign_id = $1 AND r.status IN ('failed', 'skipped')
		   AND COALESCE(r.error_code, 0) <> $2
		   AND EXISTS (SELECT 1 FROM contacts c
		               WHERE RIGHT(c.phone, 10) = RIGHT(r.phone, 10) AND c.opt_out = FALSE)
		 ORDER BY (r.status = 'skipped') DESC, r.id`, campaignID, ErrorStoppedMarketing)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	phones := []string{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		phones = append(phones, p)
	}
	return phones, rows.Err()
}

// PendingRetry reports whether a retry of the campaign is still waiting or
// going out, so a second click does not send it twice.
func PendingRetry(campaignID int) (bool, error) {
	var pending bool
	err := Pool.QueryRow(context.Background(),
		`SELECT EXISTS (SELECT 1 FROM campaigns WHERE retry_of = $1 AND status IN ('scheduled', 'sending'))`,
		campaignID).Scan(&pending)
	return pending, err
}

// PaidUsedLast24h counts the different people sent a paid template in the
// last 24 hours, which is what Meta's daily limit counts. Sends Meta later
// dropped do not count. It also reads the log, so template sends from before
// delivery was tracked are counted too.
func PaidUsedLast24h() (int, error) {
	var n int
	err := Pool.QueryRow(context.Background(),
		`SELECT COUNT(DISTINCT RIGHT(m.phone, 10))
		 FROM messages_log m
		 WHERE m.direction = 'outgoing' AND m.message LIKE '[Template:%'
		   AND m.sent_at > NOW() - INTERVAL '24 hours'
		   AND NOT EXISTS (
		       SELECT 1 FROM campaign_recipients r
		       WHERE RIGHT(r.phone, 10) = RIGHT(m.phone, 10) AND r.channel = 'template'
		         AND r.sent_at > NOW() - INTERVAL '24 hours'
		       GROUP BY RIGHT(r.phone, 10)
		       HAVING BOOL_AND(r.status IN ('failed', 'skipped')))`).Scan(&n)
	return n, err
}

// LastOffers returns when each contact last got an offer, keyed on the last
// ten digits of the phone. Contacts never sent one are missing.
func LastOffers() (map[string]time.Time, error) {
	rows, err := Pool.Query(context.Background(),
		`SELECT RIGHT(phone, 10), MAX(sent_at) FROM campaign_recipients
		 WHERE status <> 'skipped' GROUP BY RIGHT(phone, 10)
		 UNION ALL
		 SELECT RIGHT(phone, 10), MAX(sent_at)::timestamptz FROM messages_log
		 WHERE direction = 'outgoing' AND message LIKE '[Template:%' GROUP BY RIGHT(phone, 10)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]time.Time{}
	for rows.Next() {
		var k string
		var t time.Time
		if err := rows.Scan(&k, &t); err != nil {
			return nil, err
		}
		if t.After(out[k]) {
			out[k] = t
		}
	}
	return out, rows.Err()
}

// OfferContact is one subscribed contact with what they were last sent.
type OfferContact struct {
	Phone          string     `json:"phone"`
	Name           string     `json:"name"`
	OptOut         bool       `json:"opt_out"`
	LastIncomingAt *time.Time `json:"last_incoming_at"`
	LastOfferAt    *time.Time `json:"last_offer_at"`
	// sent | delivered | read | failed | skipped, or "untracked" for an
	// offer sent before delivery was followed. Empty when never sent one.
	LastStatus   string `json:"last_status"`
	LastChannel  string `json:"last_channel"`
	LastError    string `json:"last_error"`
	LastCampaign int    `json:"last_campaign"`
	OffersSent   int    `json:"offers_sent"`
}

// GetOfferContacts lists every contact with their latest offer, for
// following who was sent what and when.
func GetOfferContacts() ([]OfferContact, error) {
	rows, err := Pool.Query(context.Background(),
		`WITH latest AS (
		     SELECT DISTINCT ON (RIGHT(phone, 10)) RIGHT(phone, 10) AS k,
		            sent_at, status, channel, COALESCE(error, '') AS error, campaign_id
		     FROM campaign_recipients
		     ORDER BY RIGHT(phone, 10), (status = 'skipped'), sent_at DESC, id DESC
		 ), counted AS (
		     SELECT RIGHT(phone, 10) AS k, COUNT(DISTINCT campaign_id) AS n
		     FROM campaign_recipients WHERE status <> 'skipped' GROUP BY 1
		 ), legacy AS (
		     SELECT RIGHT(phone, 10) AS k, MAX(sent_at)::timestamptz AS sent_at, COUNT(*) AS n
		     FROM messages_log
		     WHERE direction = 'outgoing' AND message LIKE '[Template:%'
		       AND NOT EXISTS (SELECT 1 FROM campaign_recipients r
		                       WHERE r.wa_msg_id IS NOT NULL AND RIGHT(r.phone, 10) = RIGHT(messages_log.phone, 10))
		     GROUP BY 1
		 ), incoming AS (
		     SELECT RIGHT(phone, 10) AS k, MAX(sent_at)::timestamptz AS at
		     FROM messages_log WHERE direction = 'incoming' GROUP BY 1
		 )
		 SELECT c.phone, COALESCE(c.name, ''), c.opt_out, i.at,
		        COALESCE(l.sent_at, g.sent_at),
		        COALESCE(l.status, CASE WHEN g.k IS NOT NULL THEN 'untracked' ELSE '' END),
		        COALESCE(l.channel, CASE WHEN g.k IS NOT NULL THEN 'template' ELSE '' END),
		        COALESCE(l.error, ''), COALESCE(l.campaign_id, 0),
		        COALESCE(n.n, 0) + COALESCE(g.n, 0)
		 FROM contacts c
		 LEFT JOIN latest l ON l.k = RIGHT(c.phone, 10)
		 LEFT JOIN counted n ON n.k = RIGHT(c.phone, 10)
		 LEFT JOIN legacy g ON g.k = RIGHT(c.phone, 10)
		 LEFT JOIN incoming i ON i.k = RIGHT(c.phone, 10)
		 ORDER BY COALESCE(l.sent_at, g.sent_at) DESC NULLS LAST, c.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []OfferContact{}
	for rows.Next() {
		var o OfferContact
		if err := rows.Scan(&o.Phone, &o.Name, &o.OptOut, &o.LastIncomingAt, &o.LastOfferAt,
			&o.LastStatus, &o.LastChannel, &o.LastError, &o.LastCampaign, &o.OffersSent); err != nil {
			return nil, err
		}
		list = append(list, o)
	}
	return list, rows.Err()
}
