/* eslint-disable prefer-const */ // to satisfy AS compiler
import {
  Mint,
  Redeem,
  Borrow,
  RepayBorrow,
  LiquidateBorrow,
  Transfer,
  AccrueInterest,
  NewReserveFactor,
  NewMarketInterestRateModel,
} from '../types/templates/CToken/CToken'
import {
  Market,
  Account,
  MintEvent,
  RedeemEvent,
  LiquidationEvent,
  TransferEvent,
  BorrowEvent,
  RepayEvent,
} from '../types/schema'

import { createMarket, updateMarket } from './markets'
import {
  createAccount,
  updateCommonCTokenStats,
  exponentToBigDecimal,
  cTokenDecimalsBD,
  cTokenDecimals,
} from './helpers'

/* Account supplies assets into market and receives cTokens in exchange
 *
 * event.mintAmount is the underlying asset
 * event.mintTokens is the amount of cTokens minted
 * event.minter is the account
 *
 * Notes
 *    Transfer event will always get emitted with this
 *    Mints originate from the cToken address, not 0x000000, which is typical of ERC-20s
 *    No need to updateMarket(), handleAccrueInterest() ALWAYS runs before this
 *    No need to updateCommonCTokenStats, handleTransfer() will
 *    No need to update cTokenBalance, handleTransfer() will
 */
export function handleMint(event: Mint): void {
  let market = Market.load(event.address.toHexString())
  let mintID = event.transaction.hash
    .toHexString()
    .concat('-')
    .concat(event.transactionLogIndex.toString())

  let cTokenAmount = event.params.mintTokens
    .toBigDecimal()
    .div(cTokenDecimalsBD)
    .truncate(cTokenDecimals)
  let underlyingAmount = event.params.mintAmount
    .toBigDecimal()
    .div(exponentToBigDecimal(market.underlyingDecimals))
    .truncate(market.underlyingDecimals)

  let mint = new MintEvent(mintID)
  mint.amount = cTokenAmount
  mint.to = event.params.minter
  mint.from = event.address
  mint.blockNumber = event.block.number.toI32()
  mint.blockTime = event.block.timestamp.toI32()
  mint.cTokenSymbol = market.symbol
  mint.underlyingAmount = underlyingAmount
  mint.save()
}

/*  Account supplies cTokens into market and receives underlying asset in exchange
 *
 *  event.redeemAmount is the underlying asset
 *  event.redeemTokens is the cTokens
 *  event.redeemer is the account
 *
 *  Notes
 *    Transfer event will always get emitted with this
 *    No need to updateMarket(), handleAccrueInterest() ALWAYS runs before this
 *    No need to updateCommonCTokenStats, handleTransfer() will
 *    No need to update cTokenBalance, handleTransfer() will
 */
export function handleRedeem(event: Redeem): void {
  let market = Market.load(event.address.toHexString())
  let redeemID = event.transaction.hash
    .toHexString()
    .concat('-')
    .concat(event.transactionLogIndex.toString())

  let cTokenAmount = event.params.redeemTokens
    .toBigDecimal()
    .div(cTokenDecimalsBD)
    .truncate(cTokenDecimals)
  let underlyingAmount = event.params.redeemAmount
    .toBigDecimal()
    .div(exponentToBigDecimal(market.underlyingDecimals))
    .truncate(market.underlyingDecimals)

  let redeem = new RedeemEvent(redeemID)
  redeem.amount = cTokenAmount
  redeem.to = event.address
  redeem.from = event.params.redeemer
  redeem.blockNumber = event.block.number.toI32()
  redeem.blockTime = event.block.timestamp.toI32()
  redeem.cTokenSymbol = market.symbol
  redeem.underlyingAmount = underlyingAmount
  redeem.save()
}

/* Borrow assets from the protocol. All values either ETH or ERC20
 *
 * event.params.totalBorrows = of the whole market (not used right now)
 * event.params.accountBorrows = total of the account
 * event.params.borrowAmount = that was added in this event
 * event.params.borrower = the account
 * Notes
 *    No need to updateMarket(), handleAccrueInterest() ALWAYS runs before this
 */
export function handleBorrow(event: Borrow): void {
  let market = Market.load(event.address.toHexString())
  let accountID = event.params.borrower.toHex()
  let account = Account.load(accountID)
  if (account == null) {
    account = createAccount(accountID)
  }
  account.hasBorrowed = true
  account.save()

  // Update cTokenStats common for all events, and return the stats to update unique
  // values for each event
  let cTokenStats = updateCommonCTokenStats(
    market.id,
    market.symbol,
    accountID,
    event.transaction.hash,
    event.block.timestamp,
    event.block.number,
    event.logIndex,
  )

  let borrowAmountBD = event.params.borrowAmount
    .toBigDecimal()
    .div(exponentToBigDecimal(market.underlyingDecimals))

  cTokenStats.storedBorrowBalance = event.params.accountBorrows
    .toBigDecimal()
    .div(exponentToBigDecimal(market.underlyingDecimals))
    .truncate(market.underlyingDecimals)

  cTokenStats.accountBorrowIndex = market.borrowIndex
  cTokenStats.totalUnderlyingBorrowed = cTokenStats.totalUnderlyingBorrowed.plus(
    borrowAmountBD,
  )
  cTokenStats.save()

  let borrowID = event.transaction.hash
    .toHexString()
    .concat('-')
    .concat(event.transactionLogIndex.toString())

  let borrowAmount = event.params.borrowAmount
    .toBigDecimal()
    .div(exponentToBigDecimal(market.underlyingDecimals))
    .truncate(market.underlyingDecimals)

  let accountBorrows = event.params.accountBorrows
    .toBigDecimal()
    .div(exponentToBigDecimal(market.underlyingDecimals))
    .truncate(market.underlyingDecimals)

  let borrow = new BorrowEvent(borrowID)
  borrow.amount = borrowAmount
  borrow.accountBorrows = accountBorrows
  borrow.borrower = event.params.borrower
  borrow.blockNumber = event.block.number.toI32()
  borrow.blockTime = event.block.timestamp.toI32()
  borrow.underlyingSymbol = market.underlyingSymbol
  borrow.save()
}

/* Repay some amount borrowed. Anyone can repay anyones balance
 *
 * event.params.totalBorrows = of the whole market (not used right now)
 * event.params.accountBorrows = total of the account (not used right now)
 * event.params.repayAmount = that was added in this event
 * event.params.borrower = the borrower
 * event.params.payer = the payer
 *
 * Notes
 *    No need to updateMarket(), handleAccrueInterest() ALWAYS runs before this
 *    Once a account totally repays a borrow, it still has its account interest index set to the
 *    markets value. We keep this, even though you might think it would reset to 0 upon full
 *    repay.
 */
export function handleRepayBorrow(event: RepayBorrow): void {
  let market = Market.load(event.address.toHexString())
  let accountID = event.params.borrower.toHex()
  let account = Account.load(accountID)
  if (account == null) {
    createAccount(accountID)
  }

  // Update cTokenStats common for all events, and return the stats to update unique
  // values for each event
  let cTokenStats = updateCommonCTokenStats(
    market.id,
    market.symbol,
    accountID,
    event.transaction.hash,
    event.block.timestamp,
    event.block.number,
    event.logIndex,
  )

  let repayAmountBD = event.params.repayAmount
    .toBigDecimal()
    .div(exponentToBigDecimal(market.underlyingDecimals))

  cTokenStats.storedBorrowBalance = event.params.accountBorrows
    .toBigDecimal()
    .div(exponentToBigDecimal(market.underlyingDecimals))
    .truncate(market.underlyingDecimals)

  cTokenStats.accountBorrowIndex = market.borrowIndex
  cTokenStats.totalUnderlyingRepaid = cTokenStats.totalUnderlyingRepaid.plus(
    repayAmountBD,
  )
  cTokenStats.save()

  let repayID = event.transaction.hash
    .toHexString()
    .concat('-')
    .concat(event.transactionLogIndex.toString())

  let repayAmount = event.params.repayAmount
    .toBigDecimal()
    .div(exponentToBigDecimal(market.underlyingDecimals))
    .truncate(market.underlyingDecimals)

  let accountBorrows = event.params.accountBorrows
    .toBigDecimal()
    .div(exponentToBigDecimal(market.underlyingDecimals))
    .truncate(market.underlyingDecimals)

  let repay = new RepayEvent(repayID)
  repay.amount = repayAmount
  repay.accountBorrows = accountBorrows
  repay.borrower = event.params.borrower
  repay.blockNumber = event.block.number.toI32()
  repay.blockTime = event.block.timestamp.toI32()
  repay.underlyingSymbol = market.underlyingSymbol
  repay.payer = event.params.payer
  repay.save()
}

/*
 * Liquidate an account who has fell below the collateral factor.
 *
 * event.params.borrower - the borrower who is getting liquidated of their cTokens
 * event.params.cTokenCollateral - the market ADDRESS of the ctoken being liquidated
 * event.params.liquidator - the liquidator
 * event.params.repayAmount - the amount of underlying to be repaid
 * event.params.seizeTokens - cTokens seized (transfer event should handle this)
 *
 * Notes
 *    No need to updateMarket(), handleAccrueInterest() ALWAYS runs before this.
 *    When calling this function, event RepayBorrow, and event Transfer will be called every
 *    time. This means we can ignore repayAmount. Seize tokens only changes state
 *    of the cTokens, which is covered by transfer. Therefore we only
 *    add liquidation counts in this handler.
 */
export function handleLiquidateBorrow(event: LiquidateBorrow): void {
  let liquidatorID = event.params.liquidator.toHex()
  let liquidator = Account.load(liquidatorID)
  if (liquidator == null) {
    liquidator = createAccount(liquidatorID)
  }
  liquidator.countLiquidator = liquidator.countLiquidator + 1
  liquidator.save()

  let borrowerID = event.params.borrower.toHex()
  let borrower = Account.load(borrowerID)
  if (borrower == null) {
    borrower = createAccount(borrowerID)
  }
  borrower.countLiquidated = borrower.countLiquidated + 1
  borrower.save()

  // For a liquidation, the liquidator pays down the borrow of the underlying
  // asset. They seize one of potentially many types of cToken collateral of
  // the underwater borrower. So we must get that address from the event, and
  // the repay token is the event.address
  let marketRepayToken = Market.load(event.address.toHexString())
  let marketCTokenLiquidated = Market.load(event.params.cTokenCollateral.toHexString())
  let mintID = event.transaction.hash
    .toHexString()
    .concat('-')
    .concat(event.transactionLogIndex.toString())

  let cTokenAmount = event.params.seizeTokens
    .toBigDecimal()
    .div(cTokenDecimalsBD)
    .truncate(cTokenDecimals)
  let underlyingRepayAmount = event.params.repayAmount
    .toBigDecimal()
    .div(exponentToBigDecimal(marketRepayToken.underlyingDecimals))
    .truncate(marketRepayToken.underlyingDecimals)

  let liquidation = new LiquidationEvent(mintID)
  liquidation.amount = cTokenAmount
  liquidation.to = event.params.liquidator
  liquidation.from = event.params.borrower
  liquidation.blockNumber = event.block.number.toI32()
  liquidation.blockTime = event.block.timestamp.toI32()
  liquidation.underlyingSymbol = marketRepayToken.underlyingSymbol
  liquidation.underlyingRepayAmount = underlyingRepayAmount
  liquidation.cTokenSymbol = marketCTokenLiquidated.symbol
  liquidation.save()
}

/* Transferring of cTokens
 *
 * event.params.from = sender of cTokens
 * event.params.to = receiver of cTokens
 * event.params.amount = amount sent
 *
 * Notes
 *    Possible ways to emit Transfer:
 *      seize() - i.e. a Liquidation Transfer (does not emit anything else)
 *      redeemFresh() - i.e. redeeming your cTokens for underlying asset
 *      mintFresh() - i.e. you are lending underlying assets to create ctokens
 *      transfer() - i.e. a basic transfer
 *    This function handles all 4 cases. Transfer is emitted alongside the mint, redeem, and seize
 *    events. So for those events, we do not update cToken balances.
 */
export function handleTransfer(event: Transfer): void {
  // We only updateMarket() if accrual block number is not up to date. This will only happen
  // with normal transfers, since mint, redeem, and seize transfers will already run updateMarket()
  let marketID = event.address.toHexString()
  let market = Market.load(marketID)
  if (market.accrualBlockNumber != event.block.number.toI32()) {
    market = updateMarket(
      event.address,
      event.block.number.toI32(),
      event.block.timestamp.toI32(),
    )
  }

  let amountUnderlying = market.exchangeRate.times(
    event.params.amount.toBigDecimal().div(cTokenDecimalsBD),
  )
  let amountUnderlyingTruncated = amountUnderlying.truncate(market.underlyingDecimals)

  // Checking if the tx is FROM the cToken contract (i.e. this will not run when minting)
  // If so, it is a mint, and we don't need to run these calculations
  let accountFromID = event.params.from.toHex()
  if (accountFromID != marketID) {
    let accountFrom = Account.load(accountFromID)
    if (accountFrom == null) {
      createAccount(accountFromID)
    }

    // Update cTokenStats common for all events, and return the stats to update unique
    // values for each event
    let cTokenStatsFrom = updateCommonCTokenStats(
      market.id,
      market.symbol,
      accountFromID,
      event.transaction.hash,
      event.block.timestamp,
      event.block.number,
      event.logIndex,
    )

    cTokenStatsFrom.cTokenBalance = cTokenStatsFrom.cTokenBalance.minus(
      event.params.amount
        .toBigDecimal()
        .div(cTokenDecimalsBD)
        .truncate(cTokenDecimals),
    )

    cTokenStatsFrom.totalUnderlyingRedeemed = cTokenStatsFrom.totalUnderlyingRedeemed.plus(
      amountUnderlyingTruncated,
    )
    cTokenStatsFrom.save()
  }

  // Checking if the tx is TO the cToken contract (i.e. this will not run when redeeming)
  // If so, we ignore it. this leaves an edge case, where someone who accidentally sends
  // cTokens to a cToken contract, where it will not get recorded. Right now it would
  // be messy to include, so we are leaving it out for now TODO fix this in future
  let accountToID = event.params.to.toHex()
  if (accountToID != marketID) {
    let accountTo = Account.load(accountToID)
    if (accountTo == null) {
      createAccount(accountToID)
    }

    // Update cTokenStats common for all events, and return the stats to update unique
    // values for each event
    let cTokenStatsTo = updateCommonCTokenStats(
      market.id,
      market.symbol,
      accountToID,
      event.transaction.hash,
      event.block.timestamp,
      event.block.number,
      event.logIndex,
    )

    cTokenStatsTo.cTokenBalance = cTokenStatsTo.cTokenBalance.plus(
      event.params.amount
        .toBigDecimal()
        .div(cTokenDecimalsBD)
        .truncate(cTokenDecimals),
    )

    cTokenStatsTo.totalUnderlyingSupplied = cTokenStatsTo.totalUnderlyingSupplied.plus(
      amountUnderlyingTruncated,
    )
    cTokenStatsTo.save()
  }

  let transferID = event.transaction.hash
    .toHexString()
    .concat('-')
    .concat(event.transactionLogIndex.toString())

  let transfer = new TransferEvent(transferID)
  transfer.amount = event.params.amount.toBigDecimal().div(cTokenDecimalsBD)
  transfer.to = event.params.to
  transfer.from = event.params.from
  transfer.blockNumber = event.block.number.toI32()
  transfer.blockTime = event.block.timestamp.toI32()
  transfer.cTokenSymbol = market.symbol
  transfer.save()
}

export function handleAccrueInterest(event: AccrueInterest): void {
  updateMarket(event.address, event.block.number.toI32(), event.block.timestamp.toI32())
}

export function handleNewReserveFactor(event: NewReserveFactor): void {
  let marketID = event.address.toHex()
  let market = Market.load(marketID)
  market.reserveFactor = event.params.newReserveFactorMantissa
  market.save()
}

export function handleNewMarketInterestRateModel(
  event: NewMarketInterestRateModel,
): void {
  let marketID = event.address.toHex()
  let market = Market.load(marketID)
  if (market == null) {
    market = createMarket(marketID)
  }
  market.interestRateModelAddress = event.params.newInterestRateModel
  market.save()
}
