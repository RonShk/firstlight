// Explicit, repeatable sandbox check using a dedicated account, never the claims treasury.
import { existsSync } from "node:fs";
// v2: the first check account was left with a status-less withdrawal that Nessie cannot list.
const CHECK_ACCOUNT = "Nightwatch Integration Checks v2";
import { nessieRequest, createSettlementWithdrawal, financialSnapshot } from "../src/lib/finance/nessie";
async function main(){
 if(existsSync('.env.local'))process.loadEnvFile('.env.local');
 const customers=await nessieRequest<{_id:string;first_name:string;last_name:string}[]>('/customers');
 const customer=customers.find(c=>c.first_name==='Nightwatch'&&c.last_name==='Claims');if(!customer)throw Error('Provision the Nightwatch customer first');
 const path=`/customers/${customer._id}/accounts`;
 let accounts=await nessieRequest<{_id:string;nickname:string}[]>(path);
 if(!accounts.some(a=>a.nickname===CHECK_ACCOUNT)){await nessieRequest(path,{type:'Checking',nickname:CHECK_ACCOUNT,rewards:0,balance:100});accounts=await nessieRequest(path);}
 process.env.NESSIE_ACCOUNT_ID=accounts.find(a=>a.nickname===CHECK_ACCOUNT)!._id;
 console.log('Checking account snapshot');let snapshot=await financialSnapshot();
 console.log('Checking withdrawal');if(!snapshot.transactions.some(t=>t.description==='Nightwatch settlement INTEGRATION-CHECK-001'))await createSettlementWithdrawal('INTEGRATION-CHECK-001',1);
 snapshot=await financialSnapshot();
 const matching=snapshot.transactions.filter(t=>t.description==='Nightwatch settlement INTEGRATION-CHECK-001');
 if(matching.length!==1||matching[0].amount!==1)throw Error('Expected exactly one $1 sandbox withdrawal');
 console.log(JSON.stringify({passed:true,account:CHECK_ACCOUNT,withdrawalCount:matching.length,status:matching[0].status,balance:snapshot.account.balance}));
}
main().catch(e=>{console.error('Nessie integration check failed:', e instanceof Error ? e.message : 'unknown error');process.exitCode=1;});
