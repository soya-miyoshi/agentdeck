package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Port of src/tailnet.ts: report-only reading of `tailscale status --json`, never a boot dependency.

var tailscaleCandidates = []string{"/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"}

const adminDNSPage = "https://login.tailscale.com/admin/dns"

func tailscaleBinary() string {
	if named := os.Getenv("AGENTDECK_TAILSCALE"); named != "" {
		if _, err := os.Stat(named); err == nil {
			return named
		}
		return ""
	}
	for _, c := range tailscaleCandidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

// tailscaleEnv sets TERM, without which the macOS CLI prints an error on stdout with exit 0.
func tailscaleEnv() []string {
	env := os.Environ()
	if os.Getenv("TERM") == "" {
		env = append(env, "TERM=dumb")
	}
	return env
}

type Tailnet struct {
	Origin            string
	HTTPSCertificates bool
}

func parseTailnetStatus(raw []byte) (*Tailnet, error) {
	var status struct {
		Self struct {
			DNSName any `json:"DNSName"`
		} `json:"Self"`
		CertDomains any `json:"CertDomains"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		return nil, err
	}
	name, _ := status.Self.DNSName.(string)
	name = strings.TrimSuffix(name, ".")
	t := &Tailnet{}
	if name != "" {
		t.Origin = "https://" + name
	}
	if list, ok := status.CertDomains.([]any); ok && len(list) > 0 {
		t.HTTPSCertificates = true
	}
	return t, nil
}

func readTailnet(ctx context.Context) *Tailnet {
	bin := tailscaleBinary()
	if bin == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "status", "--json")
	cmd.Env = tailscaleEnv()
	// A killed CLI's children can hold stdout open; without this Output waits for them, not the timeout.
	cmd.WaitDelay = 500 * time.Millisecond
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	t, err := parseTailnetStatus(out)
	if err != nil {
		return nil
	}
	return t
}

func tailnetAdvice(t *Tailnet, port int, configuredOrigin string) []string {
	if t == nil {
		return []string{"agentdeck: could not read `tailscale status --json`, so nothing here knows whether the " +
			"phone can reach this server. Loopback still works; the ts.net URL needs tailscale " +
			"running and logged in on this Mac."}
	}
	var lines []string
	if t.Origin == "" {
		lines = append(lines, "agentdeck: tailscale reports no MagicDNS name for this machine, so there is no ts.net "+
			"URL to open. Enable MagicDNS at "+adminDNSPage+".")
	}
	if !t.HTTPSCertificates {
		lines = append(lines, "agentdeck: HTTPS certificates are DISABLED for this tailnet (`tailscale status --json` "+
			"reports no CertDomains), so `tailscale serve` cannot serve the ts.net name over "+
			"HTTPS and the phone gets no page. Enable HTTPS Certificates at "+adminDNSPage+". "+
			"The CLI does not say this: with Serve not enabled for the tailnet it prints an enable "+
			"link and then waits forever instead of exiting, so run it with a timeout.")
	}
	if t.Origin != "" {
		lines = append(lines, fmt.Sprintf("agentdeck: to reach this from the phone, run `tailscale serve --bg %d` on this Mac and open %s/.", port, t.Origin))
		if configuredOrigin == "" {
			lines = append(lines, "agentdeck: behind that proxy the page is same-origin, so AGENTDECK_ORIGIN="+t.Origin+
				" is the value that turns the Origin check on. Unset it again for the loopback and Vite "+
				"flows, which are a different origin and would be refused.")
		} else if configuredOrigin != t.Origin {
			lines = append(lines, "agentdeck: AGENTDECK_ORIGIN is "+configuredOrigin+", which is not this machine's tailnet origin "+
				t.Origin+". A phone loading the ts.net URL will be answered 403 on every /api call and on the socket upgrade.")
		}
	}
	return lines
}
