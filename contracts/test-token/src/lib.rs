//! Standard NEP-141 token (near-contract-standards), used only to run the
//! rate-swap sandbox tests against a real token contract. On testnet the
//! collateral is created through the FT factory instead.

use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::StorageManagement;
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue};

#[near]
#[derive(BorshStorageKey)]
enum Key {
    Token,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
}

#[near]
impl Contract {
    #[init]
    pub fn new_default_meta(owner_id: AccountId, total_supply: U128) -> Self {
        let mut token = FungibleToken::new(Key::Token);
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, total_supply.0);
        Self { token }
    }

    // ---- NEP-141 ----
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        use near_contract_standards::fungible_token::core::FungibleTokenCore;
        self.token.ft_transfer(receiver_id, amount, memo)
    }
    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        use near_contract_standards::fungible_token::core::FungibleTokenCore;
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }
    pub fn ft_total_supply(&self) -> U128 {
        use near_contract_standards::fungible_token::core::FungibleTokenCore;
        self.token.ft_total_supply()
    }
    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        use near_contract_standards::fungible_token::core::FungibleTokenCore;
        self.token.ft_balance_of(account_id)
    }
    #[private]
    pub fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
        self.token.ft_resolve_transfer(sender_id, receiver_id, amount)
    }

    // ---- NEP-145 ----
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> near_contract_standards::storage_management::StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }
    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<near_contract_standards::storage_management::StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
    pub fn storage_balance_bounds(&self) -> near_contract_standards::storage_management::StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Test USD Coin".to_string(),
            symbol: "tUSDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        Contract::ft_metadata(self)
    }
}
