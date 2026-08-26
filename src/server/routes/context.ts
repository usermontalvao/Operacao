import type { EventBus } from '../events.ts';
import type { Repository, RepositoryHandle } from '../store/index.ts';
import type { AuditService } from '../services/auditService.ts';
import type { ExecutionService } from '../services/executionService.ts';
import type { MarketDataService } from '../services/marketDataService.ts';
import type { CloseService } from '../services/closeService.ts';
import type { PaperTradingEngine } from '../services/paperTradingEngine.ts';
import type { RiskService } from '../services/riskService.ts';
import type { ScannerService } from '../services/scannerService.ts';
import type { SettingsService } from '../services/settingsService.ts';
import type { UniverseService } from '../services/universeService.ts';
import type { ScalpUniverseService } from '../services/scalpUniverseService.ts';
import type { NewsService } from '../services/newsService.ts';
import type { TradePlanService } from '../services/tradePlanService.ts';

export interface ApiContext {
  repository: Repository;
  /** estado da persistência principal — o painel precisa poder dizer que caiu */
  persistence: RepositoryHandle;
  settings: SettingsService;
  market: MarketDataService;
  scanner: ScannerService;
  universe: UniverseService;
  scalpUniverse: ScalpUniverseService;
  news: NewsService;
  execution: ExecutionService;
  close: CloseService;
  tradePlan: TradePlanService;
  risk: RiskService;
  paper: PaperTradingEngine;
  audit: AuditService;
  bus: EventBus;
}

import type { NextFunction, Request, Response } from 'express';

/** Adaptador para handlers assíncronos: erro vai para o middleware central. */
export function asyncHandler(
  handler: (request: Request, response: Response) => Promise<unknown>,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };
}
