# On-box capture runbook (rule-profiler fact-finding)

Run on a **lab BIG-IP only** (rule-profiler adds TMM overhead). Goal: nail down the
exact tmsh syntax + `/util/bash` quoting, the raw `/var/log/ltm` line format (incl. the
syslog prefix and the trailing field), and multi-TMM duplication behavior — so the
parser and worker are built against ground truth instead of the article samples.

Set these once (edit to your box):

```bash
VS=/Common/your_test_http_vs      # an existing lab HTTP virtual
VIP=10.1.10.50                    # that virtual's IP
PORT=80                           # that virtual's port
RULE=/Common/rultracer_test
RP=rultracer_probe
PUB=rultracer_pub
DEST=rultracer_local_dest
```

## 0. Environment facts (paste back all output)

```bash
node --version
tmsh show sys version | head -n 20
grep -c ^processor /proc/cpuinfo
grep -m1 'cpu MHz' /proc/cpuinfo          # for cycles<->time later (Phase 4)
tmsh show sys tmm-info | head -n 40       # how many TMMs are running
```

## 1. rule-profiler syntax + defaults

```bash
tmsh help ltm rule-profiler | cat
```

## 2. Test iRule (the article's pattern: a var set from a native command)

```bash
tmsh create ltm rule $RULE {
when HTTP_REQUEST {
  set host [HTTP::host]
  set ua [HTTP::header User-Agent]
}
}
# attach to your existing test VS (capture current rules first so you can restore):
tmsh list ltm virtual $VS rules
tmsh modify ltm virtual $VS rules { $RULE }
```

## 3. Logging chain (local syslog -> /var/log/ltm)

```bash
tmsh create sys log-config destination local-syslog $DEST
tmsh create sys log-config publisher $PUB { destinations add { $DEST } }
```

## 4. Configure the profiler — **paste back the `list` output** (shows how occ-mask is stored + all defaults)

```bash
tmsh create ltm rule-profiler $RP \
  vs-filter add { $VS } \
  rule-filter add { $RULE } \
  event-filter add { HTTP_REQUEST } \
  occ-mask { event rule rule-vm cmd-vm cmd var-mod } \
  period 60000 \
  publisher $PUB \
  state disabled
tmsh list ltm rule-profiler $RP      # <-- PASTE THIS (occ-mask encoding, defaults)
```

## 5. Capture run (no-bytecode) — **paste back the raw file**

```bash
OFF=$(wc -c < /var/log/ltm)                      # mark log offset
tmsh modify ltm rule-profiler $RP state enabled
tmsh start ltm rule-profiler $RP
for i in $(seq 1 5); do curl -sk -o /dev/null -H 'Host: example.com' "http://$VIP:$PORT/"; done
tmsh stop ltm rule-profiler $RP
tmsh modify ltm rule-profiler $RP state disabled
sleep 1
tail -c +$((OFF+1)) /var/log/ltm | grep 'RP_' > /var/tmp/rultracer_nobytecode.txt
cat /var/tmp/rultracer_nobytecode.txt            # <-- PASTE THIS (FULL lines, keep the syslog prefix!)
```

> Keep the **full** lines including the `Mon DD HH:MM:SS host tmm[pid]:` syslog prefix —
> we need it to design the prefix-stripping regex and to see how the TMM is tagged.

## 6. Capture run (with bytecode) — **paste back a short slice**

```bash
OFF=$(wc -c < /var/log/ltm)
tmsh modify ltm rule-profiler $RP occ-mask { bytecode event rule rule-vm cmd-vm cmd var-mod }
tmsh modify ltm rule-profiler $RP state enabled
tmsh start ltm rule-profiler $RP
curl -sk -o /dev/null -H 'Host: example.com' "http://$VIP:$PORT/"
tmsh stop ltm rule-profiler $RP
tmsh modify ltm rule-profiler $RP state disabled
sleep 1
tail -c +$((OFF+1)) /var/log/ltm | grep 'RP_' | head -n 80 > /var/tmp/rultracer_bytecode.txt
cat /var/tmp/rultracer_bytecode.txt              # <-- PASTE THIS
```

## 7. Multi-TMM check — **paste back both outputs**

```bash
# distinct TMM process ids across the captured RP_ lines (5th CSV field after the prefix):
grep 'RP_' /var/log/ltm | sed 's/^.*: //' | awk -F, '{print $5}' | sort | uniq -c
# the syslog prefixes seen (look for tmm0 / tmm1 / etc.):
grep 'RP_EVENT_ENTRY' /var/log/ltm | sed 's/\(tmm[0-9]*\).*/\1/' | awk '{print $NF}' | sort | uniq -c
# any rule-profiler start "alert" lines (Part 3 mentions one per TMM):
grep -i 'rule.profiler\|profiler' /var/log/ltm | grep -v 'RP_' | tail -n 20
```

## 8. Cycle-stat correlation (Phase 4 prep) — **paste back**

```bash
tmsh show ltm rule $RULE          # min/max/avg CPU cycles for the rule
```

## 9. `/util/bash` quoting verification (highest-risk worker detail) — **paste back result + list**

This is how the worker will issue tmsh. Confirm the JSON -> shell -> tmsh quoting with
braces/spaces survives. Run on the box:

```bash
curl -sku admin: https://localhost:8100/mgmt/tm/util/bash \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"run\",\"utilCmdArgs\":\"-c 'tmsh create ltm rule-profiler rultracer_probe2 vs-filter add { $VS } event-filter add { HTTP_REQUEST } occ-mask { event rule cmd } period 60000 publisher $PUB state disabled'\"}"
echo
tmsh list ltm rule-profiler rultracer_probe2     # confirm REST path created it correctly
```

> If `admin:` (no password) is rejected on `localhost:8100`, substitute real creds:
> `-u admin:<password>` against `https://<mgmt-ip>/mgmt/tm/util/bash`.

## 10. Cleanup (run when done)

```bash
tmsh delete ltm rule-profiler $RP
tmsh delete ltm rule-profiler rultracer_probe2 2>/dev/null
tmsh delete sys log-config publisher $PUB
tmsh delete sys log-config destination local-syslog $DEST
tmsh modify ltm virtual $VS rules none      # or restore the original rules from step 2
tmsh delete ltm rule $RULE
```

---

## What we learn from each artifact

| Step | Answers |
|---|---|
| 0 | Node 6.9.1 (confirmed), TMM/CPU count + clock (cycles<->µs conversion) |
| 4 | How `occ-mask` is stored (brace-list vs numeric bitmask) + field defaults |
| 5 | **Exact raw line format**: syslog prefix shape, field count per occ type, the **trailing field** value on ENTRY vs EXIT (cycles? depth?) |
| 6 | Bytecode line shape + volume; trailing field vs nesting |
| 7 | Whether lines duplicate per TMM, how the TMM is tagged (prefix `tmmN` and/or CSV `tmmPid`), flowId uniqueness across TMMs, start-alert text |
| 8 | `ltm rule stats` cycles to reconcile with trace timing (Phase 4) |
| 9 | The precise `/util/bash` escaping the worker must emit for brace/space args |
