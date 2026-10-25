package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"

	"connect-coffee-bot/db"
)

// Meta's messaging limit: how many different people paid templates may
// start a conversation with in any 24 hours. It rises as the number sends
// well (250, then 1K, 10K, 100K, unlimited).
var limitTiers = map[string]int{
	"TIER_50": 50, "TIER_250": 250, "TIER_1K": 1000, "TIER_2K": 2000,
	"TIER_10K": 10000, "TIER_100K": 100000, "TIER_UNLIMITED": 0,
}

// The lowest real tier, used when Meta cannot be asked: sending fewer than
// allowed is better than having the rest dropped.
const fallbackLimit = 250

type MessagingLimit struct {
	Tier    string `json:"tier"`
	Limit   int    `json:"limit"` // 0 means unlimited
	Quality string `json:"quality"`
	Used    int    `json:"used"`    // people sent a paid template in the last 24h
	Left    int    `json:"left"`    // -1 means unlimited
	Checked bool   `json:"checked"` // false when Meta could not be asked
	Problem string `json:"problem"`
}

var limitCache struct {
	sync.Mutex
	tier, quality string
	at            time.Time
}

// metaTier asks Meta for the number's tier and quality rating, at most every
// ten minutes.
func metaTier() (tier, quality string, err error) {
	limitCache.Lock()
	defer limitCache.Unlock()
	if limitCache.tier != "" && time.Since(limitCache.at) < 10*time.Minute {
		return limitCache.tier, limitCache.quality, nil
	}
	token, phoneID := os.Getenv("ACCESS_TOKEN"), os.Getenv("PHONE_NUMBER_ID")
	if token == "" || phoneID == "" {
		return "", "", fmt.Errorf("WhatsApp is not connected")
	}
	req, _ := http.NewRequest("GET", fmt.Sprintf(
		"https://graph.facebook.com/v21.0/%s?fields=messaging_limit_tier,quality_rating", phoneID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := metaClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	var body struct {
		Tier    string `json:"messaging_limit_tier"`
		Quality string `json:"quality_rating"`
		Error   struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	json.NewDecoder(resp.Body).Decode(&body)
	if body.Tier == "" {
		if body.Error.Message != "" {
			return "", "", fmt.Errorf("%s", body.Error.Message)
		}
		return "", "", fmt.Errorf("WhatsApp did not say (HTTP %d)", resp.StatusCode)
	}
	limitCache.tier, limitCache.quality, limitCache.at = body.Tier, body.Quality, time.Now()
	return body.Tier, body.Quality, nil
}

// messagingLimit is the daily limit and how much of it is left now.
func messagingLimit() MessagingLimit {
	m := MessagingLimit{Limit: fallbackLimit}
	if tier, quality, err := metaTier(); err != nil {
		m.Problem = "Could not ask WhatsApp for the limit, so the lowest one is assumed: " + err.Error()
	} else if n, ok := limitTiers[tier]; ok {
		m.Tier, m.Quality, m.Limit, m.Checked = tier, quality, n, true
	} else {
		m.Tier, m.Quality = tier, quality
		m.Problem = "WhatsApp reported a limit this panel does not know (" + tier + "), so the lowest one is assumed."
	}
	used, err := db.PaidUsedLast24h()
	if err != nil {
		log.Printf("[Limits] could not count today's paid sends: %v", err)
	}
	m.Used = used
	if m.Limit == 0 {
		m.Left = -1
	} else if m.Left = m.Limit - used; m.Left < 0 {
		m.Left = 0
	}
	return m
}

// capPaid keeps the paid send within what the daily limit has left and the
// number chosen for the offer. Contacts never sent an offer go first, then
// the ones sent one longest ago; the rest are held back.
func capPaid(phones []string, maxPaid int) (send, held []string, reason string) {
	left := messagingLimit().Left
	if maxPaid > 0 && (left < 0 || maxPaid < left) {
		left = maxPaid
		reason = fmt.Sprintf("Above the %d chosen for this offer.", maxPaid)
	} else {
		reason = "Over WhatsApp's daily limit. Retry after 24 hours."
	}
	if left < 0 || len(phones) <= left {
		return phones, nil, ""
	}

	last, err := db.LastOffers()
	if err != nil {
		log.Printf("[Limits] could not read past offers, keeping the list order: %v", err)
	}
	ordered := append([]string(nil), phones...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return last[lastTen(ordered[i])].Before(last[lastTen(ordered[j])])
	})
	return ordered[:left], ordered[left:], reason
}
