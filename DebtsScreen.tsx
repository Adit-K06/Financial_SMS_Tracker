import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

type Debt = { id: string; name: string; amount: number; isOwed: boolean; date: string };

export default function DebtsScreen() {
  const [debts, setDebts] = useState<Debt[]>([]);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [isOwed, setIsOwed] = useState(false); // false = I owe them, true = they owe me
  const [showForm, setShowForm] = useState(false);

  useEffect(() => { loadDebts(); }, []);

  async function loadDebts() {
    try {
      const saved = await AsyncStorage.getItem('@debts');
      if (saved) setDebts(JSON.parse(saved));
    } catch (e) { console.warn(e); }
  }

  async function saveDebts(list: Debt[]) {
    setDebts(list);
    await AsyncStorage.setItem('@debts', JSON.stringify(list));
  }

  function addDebt() {
    const parsedAmt = parseFloat(amount);
    if (!name.trim() || isNaN(parsedAmt) || parsedAmt <= 0) {
      Alert.alert('Invalid', 'Please enter a valid name and amount.');
      return;
    }
    const newDebt: Debt = {
      id: Date.now().toString(),
      name: name.trim(),
      amount: parsedAmt,
      isOwed,
      date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
    };
    saveDebts([newDebt, ...debts]);
    setName(''); setAmount(''); setShowForm(false);
  }

  function removeDebt(id: string) {
    Alert.alert('Settled?', 'Mark this debt as settled?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Yes, Settled', onPress: () => saveDebts(debts.filter(d => d.id !== id)), style: 'destructive' },
    ]);
  }

  const totalIOwe = debts.filter(d => !d.isOwed).reduce((s, d) => s + d.amount, 0);
  const totalOwedToMe = debts.filter(d => d.isOwed).reduce((s, d) => s + d.amount, 0);

  return (
    <View style={s.container}>
      {/* Summary Cards */}
      <View style={s.summaryRow}>
        <View style={[s.summaryCard, { borderTopColor: '#f43f5e' }]}>
          <Text style={s.summaryLabel}>I OWE</Text>
          <Text style={[s.summaryAmt, { color: '#f43f5e' }]}>₹{totalIOwe.toFixed(2)}</Text>
        </View>
        <View style={[s.summaryCard, { borderTopColor: '#10b981' }]}>
          <Text style={s.summaryLabel}>OWED TO ME</Text>
          <Text style={[s.summaryAmt, { color: '#10b981' }]}>₹{totalOwedToMe.toFixed(2)}</Text>
        </View>
      </View>

      {/* Add Button */}
      {!showForm && (
        <TouchableOpacity style={s.addBtn} onPress={() => setShowForm(true)}>
          <Text style={s.addBtnText}>+ Add Debt</Text>
        </TouchableOpacity>
      )}

      {/* Add Form */}
      {showForm && (
        <View style={s.form}>
          <Text style={s.formTitle}>New Debt Entry</Text>
          <TextInput style={s.input} placeholder="Person's name" placeholderTextColor="#52525b" value={name} onChangeText={setName} />
          <TextInput style={s.input} placeholder="Amount (₹)" placeholderTextColor="#52525b" value={amount} onChangeText={setAmount} keyboardType="numeric" />
          <View style={s.toggleRow}>
            <TouchableOpacity style={[s.toggleBtn, !isOwed && s.toggleActive]} onPress={() => setIsOwed(false)}>
              <Text style={[s.toggleText, !isOwed && s.toggleTextActive]}>I Owe Them</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.toggleBtn, isOwed && s.toggleActiveGreen]} onPress={() => setIsOwed(true)}>
              <Text style={[s.toggleText, isOwed && s.toggleTextActive]}>They Owe Me</Text>
            </TouchableOpacity>
          </View>
          <View style={s.formActions}>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setShowForm(false)}>
              <Text style={s.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.saveBtn} onPress={addDebt}>
              <Text style={s.saveText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Debts List */}
      <FlatList
        data={debts}
        keyExtractor={d => d.id}
        style={{ marginTop: 12 }}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyIcon}>🤝</Text>
            <Text style={s.emptyTitle}>No debts tracked</Text>
            <Text style={s.emptyBody}>Tap "+ Add Debt" to track what you owe or what others owe you.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={[s.debtCard, { borderLeftColor: item.isOwed ? '#10b981' : '#f43f5e' }]} onLongPress={() => removeDebt(item.id)}>
            <View style={s.debtRow}>
              <View style={[s.debtIcon, { backgroundColor: item.isOwed ? '#052e16' : '#3b0718' }]}>
                <Text style={s.debtIconText}>{item.isOwed ? '↓' : '↑'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.debtName}>{item.name}</Text>
                <Text style={s.debtSub}>{item.isOwed ? 'Owes you' : 'You owe'} • {item.date}</Text>
              </View>
              <Text style={[s.debtAmt, { color: item.isOwed ? '#10b981' : '#f43f5e' }]}>₹{item.amount.toFixed(2)}</Text>
            </View>
          </TouchableOpacity>
        )}
      />
      <Text style={s.hint}>Long press a debt to mark it as settled</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  summaryRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  summaryCard: { flex: 1, backgroundColor: '#16161a', borderWidth: 1, borderColor: '#22222b', borderRadius: 16, padding: 14, borderTopWidth: 3 },
  summaryLabel: { fontSize: 10, fontWeight: '700', color: '#71717a', letterSpacing: 0.5 },
  summaryAmt: { fontSize: 18, fontWeight: '800', marginTop: 4 },
  addBtn: { backgroundColor: '#4f46e5', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginBottom: 4 },
  addBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  form: { backgroundColor: '#16161a', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#27272a', marginBottom: 4 },
  formTitle: { fontSize: 15, fontWeight: '700', color: '#fff', marginBottom: 12 },
  input: { backgroundColor: '#0c0c0e', borderWidth: 1, borderColor: '#27272a', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, color: '#fff', fontSize: 14, marginBottom: 10 },
  toggleRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  toggleBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#27272a', backgroundColor: '#0c0c0e' },
  toggleActive: { backgroundColor: '#3b0718', borderColor: '#f43f5e' },
  toggleActiveGreen: { backgroundColor: '#052e16', borderColor: '#10b981' },
  toggleText: { fontSize: 13, fontWeight: '600', color: '#71717a' },
  toggleTextActive: { color: '#fff' },
  formActions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  cancelBtn: { paddingVertical: 9, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: '#27272a' },
  cancelText: { color: '#a1a1aa', fontSize: 13, fontWeight: '600' },
  saveBtn: { paddingVertical: 9, paddingHorizontal: 20, borderRadius: 10, backgroundColor: '#4f46e5' },
  saveText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  empty: { backgroundColor: '#16161a', borderWidth: 1, borderColor: '#22222b', borderRadius: 16, padding: 30, alignItems: 'center' },
  emptyIcon: { fontSize: 32, marginBottom: 10 },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: '#e4e4e7', marginBottom: 4 },
  emptyBody: { fontSize: 12, color: '#52525b', textAlign: 'center', lineHeight: 17 },
  debtCard: { backgroundColor: '#16161a', borderWidth: 1, borderColor: '#22222b', borderRadius: 14, padding: 14, marginBottom: 8, borderLeftWidth: 3 },
  debtRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  debtIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  debtIconText: { fontSize: 16, fontWeight: '900', color: '#fff' },
  debtName: { fontSize: 14, fontWeight: '700', color: '#f4f4f5' },
  debtSub: { fontSize: 11, color: '#52525b', marginTop: 2 },
  debtAmt: { fontSize: 15, fontWeight: '800' },
  hint: { textAlign: 'center', fontSize: 10, color: '#3f3f46', marginTop: 8, marginBottom: 20 },
});
