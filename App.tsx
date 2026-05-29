import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  PermissionsAndroid,
  Platform,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  StatusBar,
  Animated,
  AppState,
  AppStateStatus,
} from 'react-native';
import { NativeModules } from 'react-native';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SmsReader: { list: (filter: string, fail: (e: string) => void, success: (count: number, smsList: string) => void) => void } | undefined = (NativeModules as any).SmsReader;

// --- TYPES ---
type Transaction = {
  id: string;
  type: 'debit' | 'credit';
  amount: number;
  name: string;
  raw: string;
  timestamp: Date;
};

type ListItem =
  | { kind: 'header'; dateLabel: string; key: string }
  | { kind: 'tx'; tx: Transaction; key: string };

// --- TODAY MIDNIGHT (start of today in local time) ---
function getTodayMidnight(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
}

// --- DATE LABEL ---
function getDateLabel(date: Date): string {
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dateMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((todayMidnight - dateMidnight) / 86400000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short' });
}

// --- SMS PARSER ---
function parseSMS(smsBody: string, smsId: string, dateMs: number): Transaction | null {
  const text = smsBody.toLowerCase();

  const isDebit =
    text.includes('debited') ||
    text.includes('debit') ||
    text.includes('spent') ||
    text.includes('paid') ||
    text.includes('sent') ||
    text.includes('withdrawn') ||
    text.includes('dr.');
  const isCredit =
    text.includes('credited') ||
    text.includes('credit') ||
    text.includes('received') ||
    text.includes('added') ||
    text.includes('cr.');

  if (!isDebit && !isCredit) return null;

  const amountMatch = smsBody.match(/(?:rs\.?|inr\.?|₹)\s*([\d,]+(?:\.\d+)?)/i);
  if (!amountMatch) return null;

  const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
  if (isNaN(amount)) return null;

  let name = 'Unknown Merchant';

  const upiMatch = smsBody.match(/info:\s*upi\/[^\/]+\/([^\/]+)/i);
  if (upiMatch && upiMatch[1].trim().length > 1) {
    name = upiMatch[1].trim();
  } else {
    const matchA = smsBody.match(/debited for (?:rs\.?|inr\.?|₹).*?on.*?;\s*(.*?)\s+credited/i);
    if (matchA) {
      name = matchA[1].trim();
    } else {
      const matchB = smsBody.match(/credited with (?:rs\.?|inr\.?|₹).*?from\s+([A-Za-z0-9\s]+?)(?:\.|\s+UPI|on\s|$|Ref)/i);
      if (matchB) {
        name = matchB[1].trim();
      } else {
        const matchC = smsBody.match(/towards\s+([A-Za-z0-9\s#\-]+?)\s+(?:for|on|ref|vpa|upi|$)/i);
        if (matchC) {
          name = matchC[1].trim();
        } else {
          const namePatterns = [
            /(?:at|to|from|info:|trf to|transfer to)\s+([A-Za-z0-9\s#\-\/]+?)(?:\.|\s+UPI|on\s|$|Ref)/i,
          ];
          for (const pattern of namePatterns) {
            const match = smsBody.match(pattern);
            if (match && match[1].trim().length > 1) {
              name = match[1].trim();
              break;
            }
          }
        }
      }
    }
  }

  if (name.includes('/')) {
    const parts = name.split('/');
    const cleanPart = parts.find(p => p.trim() && !/^\d+$/.test(p) && p.toLowerCase() !== 'upi');
    if (cleanPart) name = cleanPart.trim();
  }

  name = name.replace(/\s+/g, ' ').trim();
  if (name.length > 25) name = name.substring(0, 22) + '...';

  return {
    id: smsId || Date.now().toString(),
    type: isDebit ? 'debit' : 'credit',
    amount,
    name: name || 'General Transaction',
    raw: smsBody,
    timestamp: new Date(dateMs),
  };
}

// --- GROUP TRANSACTIONS BY DATE ---
function groupByDate(transactions: Transaction[]): ListItem[] {
  const items: ListItem[] = [];
  let lastLabel = '';

  // Sort newest first
  const sorted = [...transactions].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  for (const tx of sorted) {
    const label = getDateLabel(tx.timestamp);
    if (label !== lastLabel) {
      items.push({ kind: 'header', dateLabel: label, key: `header-${label}` });
      lastLabel = label;
    }
    items.push({ kind: 'tx', tx, key: `tx-${tx.id}` });
  }
  return items;
}

// --- MAIN APP ---
export default function App() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [status, setStatus] = useState('Initializing tracker...');
  const [isSyncing, setIsSyncing] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState(false);

  // Pulse animation for the live dot
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;

  // Keep refs to avoid stale closures in intervals
  const isSyncingRef = useRef(false);
  const permissionRef = useRef(false);

  // --- PULSE ANIMATION (live indicator) ---
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.3, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const startSyncAnimation = () => {
    Animated.loop(
      Animated.timing(rotateAnim, { toValue: 1, duration: 1000, useNativeDriver: true })
    ).start();
  };

  const stopSyncAnimation = () => {
    rotateAnim.setValue(0);
    rotateAnim.stopAnimation();
  };

  const spin = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  // --- PERMISSIONS ---
  async function requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.READ_SMS,
      PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
    ]);
    return (
      results['android.permission.READ_SMS'] === 'granted' &&
      results['android.permission.RECEIVE_SMS'] === 'granted'
    );
  }

  // --- CORE SYNC ---
  const runSync = useCallback(async (quiet = false) => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    setIsSyncing(true);

    if (!quiet) {
      startSyncAnimation();
      setStatus('Scanning SMS inbox for transactions...');
    }

    if (!SmsReader) {
      console.warn('SmsReader native module not available');
      isSyncingRef.current = false;
      setIsSyncing(false);
      if (!quiet) stopSyncAnimation();
      return;
    }

    const todayMidnight = getTodayMidnight();

    SmsReader.list(
      JSON.stringify({
        box: 'inbox',
        maxCount: 200,           // Fetch more so we cover the full day
        minDate: todayMidnight,  // Only today's messages
      }),
      (fail: string) => {
        console.error('SMS list failed:', fail);
        setStatus('Failed to read SMS inbox.');
        isSyncingRef.current = false;
        setIsSyncing(false);
        if (!quiet) stopSyncAnimation();
      },
      (count: number, smsList: string) => {
        const messages: Array<{ _id: string; body: string; date: number }> = JSON.parse(smsList);

        const todayTxs = messages
          .filter(msg => msg.date >= todayMidnight)   // Double-filter in case SDK ignores minDate
          .map(msg => parseSMS(msg.body, msg._id, msg.date))
          .filter(Boolean) as Transaction[];

        setTransactions(prev => {
          // Only update state if something actually changed
          const prevIds = new Set(prev.map(t => t.id));
          const newIds = new Set(todayTxs.map(t => t.id));
          const changed = todayTxs.some(t => !prevIds.has(t.id)) || prev.some(t => !newIds.has(t.id));
          if (changed) return todayTxs;
          return prev;
        });

        isSyncingRef.current = false;
        setIsSyncing(false);
        if (!quiet) stopSyncAnimation();

        if (!quiet) {
          setStatus(`Live • ${todayTxs.length} transaction${todayTxs.length !== 1 ? 's' : ''} today`);
        }
      }
    );
  }, []);

  // --- INITIALIZE ---
  useEffect(() => {
    (async () => {
      const granted = await requestPermissions();
      setPermissionGranted(granted);
      permissionRef.current = granted;

      if (!granted) {
        setStatus('SMS access denied. Please grant permissions in Android Settings.');
        return;
      }

      // Initial full sync
      runSync(false);
      setStatus('Live • Watching for new transactions...');

      // Poll every 30 seconds — aggressive enough to feel "instant" but safe for Android
      const interval = setInterval(() => {
        if (permissionRef.current) runSync(true);
      }, 30 * 1000);

      return () => clearInterval(interval);
    })();
  }, [runSync]);

  // --- FOREGROUND DETECT: sync immediately when app is opened ---
  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'active' && permissionRef.current) {
        runSync(true); // Silent sync when app comes to foreground
      }
    };

    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, [runSync]);

  // --- STATS ---
  const totalDebit = transactions.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0);
  const totalCredit = transactions.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0);
  const listItems = groupByDate(transactions);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0c0c0e" />

      {/* ── HEADER ── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>SMS Tracker</Text>
          <View style={styles.liveRow}>
            <Animated.View style={[styles.liveDot, { opacity: pulseAnim }]} />
            <Text style={styles.liveText}>LIVE</Text>
            <Text style={styles.liveSubtext}> • Updates every 30s</Text>
          </View>
        </View>

        {/* Manual Sync Button */}
        <TouchableOpacity
          style={[styles.syncBtn, isSyncing && styles.syncBtnActive]}
          onPress={() => runSync(false)}
          disabled={isSyncing}
        >
          <Animated.Text style={[styles.syncBtnIcon, isSyncing && { transform: [{ rotate: spin }] }]}>
            🔄
          </Animated.Text>
          <Text style={styles.syncBtnText}>{isSyncing ? 'Syncing' : 'Sync'}</Text>
        </TouchableOpacity>
      </View>

      {/* ── STATUS BAR ── */}
      <View style={styles.statusBanner}>
        {isSyncing && <ActivityIndicator size={12} color="#818cf8" style={{ marginRight: 6 }} />}
        <Text style={styles.statusText} numberOfLines={1}>{status}</Text>
      </View>

      {/* ── MAIN SCROLL ── */}
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* Permission Warning */}
        {!permissionGranted && (
          <View style={styles.warningCard}>
            <Text style={styles.warningIcon}>⚠️</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.warningTitle}>SMS Permission Required</Text>
              <Text style={styles.warningBody}>
                Please grant SMS permission in Android Settings to read bank transactions.
              </Text>
            </View>
          </View>
        )}

        {/* Metric Cards */}
        <View style={styles.metricGrid}>
          <View style={[styles.metricCard, styles.debitCard]}>
            <Text style={styles.metricEmoji}>💸</Text>
            <Text style={styles.metricLabel}>Total Spent</Text>
            <Text style={[styles.metricValue, styles.debitValue]}>
              ₹{totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </Text>
            <Text style={styles.metricSub}>{transactions.filter(t => t.type === 'debit').length} debits today</Text>
          </View>

          <View style={[styles.metricCard, styles.creditCard]}>
            <Text style={styles.metricEmoji}>💰</Text>
            <Text style={styles.metricLabel}>Total Received</Text>
            <Text style={[styles.metricValue, styles.creditValue]}>
              ₹{totalCredit.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </Text>
            <Text style={styles.metricSub}>{transactions.filter(t => t.type === 'credit').length} credits today</Text>
          </View>
        </View>

        {/* Transactions Header */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>Today's Transactions</Text>
          <View style={styles.countPill}>
            <Text style={styles.countText}>{transactions.length}</Text>
          </View>
        </View>

        {/* Transaction List with Date Dividers */}
        {listItems.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyIcon}>📭</Text>
            <Text style={styles.emptyTitle}>No transactions today</Text>
            <Text style={styles.emptyBody}>
              We're monitoring your SMS inbox from this morning. Bank transaction messages will appear here automatically.
            </Text>
          </View>
        ) : (
          <FlatList
            data={listItems}
            scrollEnabled={false}
            keyExtractor={item => item.key}
            renderItem={({ item }) => {
              if (item.kind === 'header') {
                return (
                  <View style={styles.dateDivider}>
                    <View style={styles.dateLine} />
                    <View style={styles.datePill}>
                      <Text style={styles.datePillText}>{item.dateLabel}</Text>
                    </View>
                    <View style={styles.dateLine} />
                  </View>
                );
              }

              const tx = item.tx;
              const isDebit = tx.type === 'debit';

              return (
                <View style={[styles.txCard, isDebit ? styles.txDebitBorder : styles.txCreditBorder]}>
                  <View style={styles.txRow}>
                    {/* Icon + Name */}
                    <View style={[styles.txIconWrap, isDebit ? styles.txIconDebit : styles.txIconCredit]}>
                      <Text style={styles.txIcon}>{isDebit ? '↑' : '↓'}</Text>
                    </View>

                    <View style={styles.txMeta}>
                      <Text style={styles.txName}>{tx.name}</Text>
                      <Text style={styles.txTime}>
                        {tx.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                    </View>

                    {/* Amount */}
                    <Text style={[styles.txAmount, isDebit ? styles.txDebitAmt : styles.txCreditAmt]}>
                      {isDebit ? '−' : '+'} ₹{tx.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </Text>
                  </View>

                  {/* Raw SMS preview */}
                  <View style={styles.rawWrap}>
                    <Text style={styles.rawText} numberOfLines={2}>{tx.raw}</Text>
                  </View>
                </View>
              );
            }}
          />
        )}
      </ScrollView>
    </View>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0c0c0e',
    paddingTop: Platform.OS === 'ios' ? 52 : 24,
  },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#18181b',
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: -0.5,
  },
  liveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 5,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#10b981',
    marginRight: 5,
  },
  liveText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#10b981',
    letterSpacing: 1,
  },
  liveSubtext: {
    fontSize: 10,
    fontWeight: '500',
    color: '#52525b',
  },

  // Sync Button
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#18181b',
    borderWidth: 1,
    borderColor: '#27272a',
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  syncBtnActive: {
    borderColor: '#4f46e5',
    backgroundColor: '#1e1b4b',
  },
  syncBtnIcon: { fontSize: 14 },
  syncBtnText: {
    color: '#a1a1aa',
    fontSize: 13,
    fontWeight: '600',
  },

  // Status Bar
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111113',
    borderBottomWidth: 1,
    borderBottomColor: '#18181b',
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  statusText: {
    color: '#71717a',
    fontSize: 11.5,
    fontWeight: '500',
    flex: 1,
  },

  // Scroll
  scrollContent: {
    padding: 16,
    paddingBottom: 50,
  },

  // Warning
  warningCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#1c1108',
    borderWidth: 1,
    borderColor: '#854d0e',
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
  },
  warningIcon: { fontSize: 22 },
  warningTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fbbf24',
    marginBottom: 2,
  },
  warningBody: {
    fontSize: 11,
    color: '#a16207',
    lineHeight: 15,
  },

  // Metric Cards
  metricGrid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
  },
  metricCard: {
    flex: 1,
    backgroundColor: '#16161a',
    borderWidth: 1,
    borderColor: '#22222b',
    borderRadius: 18,
    padding: 16,
  },
  debitCard: {
    borderTopWidth: 3,
    borderTopColor: '#f43f5e',
  },
  creditCard: {
    borderTopWidth: 3,
    borderTopColor: '#10b981',
  },
  metricEmoji: {
    fontSize: 22,
    marginBottom: 8,
  },
  metricLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    color: '#71717a',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  metricValue: {
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 4,
  },
  debitValue: { color: '#f43f5e' },
  creditValue: { color: '#10b981' },
  metricSub: {
    fontSize: 10,
    color: '#3f3f46',
    fontWeight: '500',
  },

  // Section header
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#ffffff',
  },
  countPill: {
    backgroundColor: '#27272a',
    borderRadius: 100,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#a1a1aa',
  },

  // Date Divider
  dateDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 14,
    gap: 8,
  },
  dateLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#1e1e24',
  },
  datePill: {
    backgroundColor: '#1a1a22',
    borderRadius: 100,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#2e2e3a',
  },
  datePillText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6366f1',
    letterSpacing: 0.3,
  },

  // Empty State
  emptyCard: {
    backgroundColor: '#16161a',
    borderWidth: 1,
    borderColor: '#22222b',
    borderRadius: 18,
    padding: 32,
    alignItems: 'center',
  },
  emptyIcon: { fontSize: 36, marginBottom: 12 },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#e4e4e7',
    marginBottom: 6,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 12,
    color: '#52525b',
    textAlign: 'center',
    lineHeight: 17,
  },

  // Transaction Card
  txCard: {
    backgroundColor: '#16161a',
    borderWidth: 1,
    borderColor: '#22222b',
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
  },
  txDebitBorder: {
    borderLeftWidth: 3,
    borderLeftColor: '#f43f5e',
  },
  txCreditBorder: {
    borderLeftWidth: 3,
    borderLeftColor: '#10b981',
  },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  txIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  txIconDebit: {
    backgroundColor: '#3b0718',
  },
  txIconCredit: {
    backgroundColor: '#052e16',
  },
  txIcon: {
    fontSize: 16,
    fontWeight: '900',
    color: '#fff',
  },
  txMeta: {
    flex: 1,
  },
  txName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#f4f4f5',
  },
  txTime: {
    fontSize: 11,
    color: '#52525b',
    marginTop: 2,
    fontWeight: '500',
  },
  txAmount: {
    fontSize: 15,
    fontWeight: '800',
    textAlign: 'right',
  },
  txDebitAmt: { color: '#f43f5e' },
  txCreditAmt: { color: '#10b981' },

  // Raw SMS
  rawWrap: {
    marginTop: 10,
    backgroundColor: '#111113',
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: '#1e1e24',
  },
  rawText: {
    fontSize: 10,
    color: '#3f3f46',
    lineHeight: 13.5,
  },
});